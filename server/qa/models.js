/**
 * Model access for the QA engine.
 *
 * Two optional models assist the deterministic engine:
 *   - the reasoner (an OpenAI-compatible chat model, Opus by default) explores
 *     user flows, reviews screenshots and writes fix prompts;
 *   - JEV (TypeSafe Decisions) verifies candidate defects and grades severity.
 *
 * Neither model is required. Every call is bounded by a timeout, a retry
 * budget and a per-run token/call budget. A failure is recorded and the
 * engine keeps going with what it has, so a model outage can never stop a run.
 */
import { prepareJevRequest, JEV_ENDPOINT, JEV_MODEL } from '../jevClient.js';
import { getConfig } from '../config.js';

export const DEFAULT_REASONER_MODEL = 'drytis/claude-opus-4.7';
export const DEFAULT_REASONER_BASE_URL = 'https://llm.drytis.ai/v1';

const positive = (value, fallback, max) => {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? Math.min(max, Math.floor(number)) : fallback;
};

function safeConfig() {
	try { return getConfig() ?? {}; } catch { return {}; }
}

/** Resolves model settings from the environment and saved configuration. */
export function qaModelSettings(env = process.env, config = safeConfig()) {
	const sharedKey = String(config.apiKey || env.QASE_API_KEY || '').trim();
	const reasonerKey = String(env.QASE_REASONER_API_KEY || sharedKey).trim();
	const jevKey = String(env.JEV_API_KEY || sharedKey).trim();
	return {
		reasoner: {
			enabled: env.QASE_QA_REASONER !== 'false' && Boolean(reasonerKey),
			model: env.QASE_REASONER_MODEL || DEFAULT_REASONER_MODEL,
			baseUrl: String(env.QASE_REASONER_BASE_URL || DEFAULT_REASONER_BASE_URL).replace(/\/+$/, ''),
			apiKey: reasonerKey,
			timeoutMs: positive(env.QASE_REASONER_TIMEOUT_MS, 120000, 300000),
			maxCalls: positive(env.QASE_QA_REASONER_CALLS, 80, 400),
			maxTokens: positive(env.QASE_QA_REASONER_TOKENS, 600000, 4000000),
			vision: env.QASE_REASONER_VISION !== 'false'
		},
		jev: {
			enabled: env.QASE_QA_JEV !== 'false' && Boolean(jevKey),
			model: JEV_MODEL,
			baseUrl: env.QASE_JEV_BASE_URL || JEV_ENDPOINT,
			apiKey: jevKey,
			timeoutMs: positive(env.QASE_JEV_TIMEOUT_MS, 45000, 120000),
			maxCalls: positive(env.QASE_QA_JEV_CALLS, 40, 200)
		}
	};
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
	const timer = setTimeout(resolve, ms);
	signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

function retryable(error) {
	const status = error?.httpStatus;
	return !status || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/** Extracts the first JSON value from model text (fenced or bare). */
export function parseModelJson(text) {
	if (typeof text !== 'string') return undefined;
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	for (const candidate of [fenced?.[1], text]) {
		if (!candidate) continue;
		const trimmed = candidate.trim();
		try { return JSON.parse(trimmed); } catch { /* try the outermost bracketed value */ }
		const start = trimmed.search(/[[{]/);
		if (start < 0) continue;
		const end = trimmed.lastIndexOf(trimmed[start] === '[' ? ']' : '}');
		if (end > start) {
			try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* not JSON */ }
		}
	}
	return undefined;
}

/**
 * Creates the per-run model layer. `state` is persisted run state; usage
 * survives restarts so budgets stay honest across a resume.
 */
export function createQaModels({ settings = qaModelSettings(), state = {}, fetchImpl = fetch, onUsage, log = () => {} } = {}) {
	state.reasoner ??= { model: settings.reasoner.model, calls: 0, failures: 0, inputTokens: 0, outputTokens: 0 };
	state.jev ??= { model: settings.jev.model, calls: 0, failures: 0, inputTokens: 0, outputTokens: 0 };
	state.reasoner.enabled = settings.reasoner.enabled;
	state.jev.enabled = settings.jev.enabled;
	// Consecutive failures open a circuit so a dead gateway costs seconds, not minutes.
	const circuit = { reasoner: 0, jev: 0 };

	const reasonerAvailable = () => settings.reasoner.enabled && circuit.reasoner < 3 &&
		state.reasoner.calls < settings.reasoner.maxCalls &&
		state.reasoner.inputTokens + state.reasoner.outputTokens < settings.reasoner.maxTokens;
	const jevAvailable = () => settings.jev.enabled && circuit.jev < 3 && state.jev.calls < settings.jev.maxCalls;

	async function reasonerRequest(body, signal) {
		const response = await fetchImpl(`${settings.reasoner.baseUrl}/chat/completions`, {
			method: 'POST',
			signal: AbortSignal.any([AbortSignal.timeout(settings.reasoner.timeoutMs), ...(signal ? [signal] : [])]),
			headers: { Authorization: `Bearer ${settings.reasoner.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify({ model: settings.reasoner.model, ...body })
		});
		if (!response.ok) {
			await response.body?.cancel?.();
			throw Object.assign(new Error(`Reasoner HTTP ${response.status}`), { httpStatus: response.status });
		}
		return response.json();
	}

	/**
	 * JEV transport. Unlike the strict SQA client, a missing usage receipt never
	 * discards valid answers: usage is recorded when present and each answer is
	 * validated individually, so one malformed answer drops only itself.
	 */
	async function jevRequest(context, questions, signal) {
		const body = prepareJevRequest(context, questions, { model: settings.jev.model });
		const response = await fetchImpl(settings.jev.baseUrl, {
			method: 'POST', redirect: 'error',
			signal: AbortSignal.any([AbortSignal.timeout(settings.jev.timeoutMs), ...(signal ? [signal] : [])]),
			headers: { Authorization: `Bearer ${settings.jev.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
			body
		});
		if (!response.ok) {
			await response.body?.cancel?.();
			throw Object.assign(new Error(`JEV HTTP ${response.status}`), { httpStatus: response.status });
		}
		const raw = await response.json();
		const inputTokens = Number(raw?.usage?.input_tokens) || 0;
		const outputTokens = Number(raw?.usage?.output_tokens) || 0;
		state.jev.inputTokens += inputTokens;
		state.jev.outputTokens += outputTokens;
		onUsage?.({ model: settings.jev.model, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: !raw?.usage });
		const answers = {};
		for (const [id, question] of Object.entries(questions)) {
			const answer = raw?.answers?.[id];
			if (!answer || typeof answer !== 'object') continue;
			if (question.type === 'noul' && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1) answers[id] = answer;
			else if (question.type === 'score' && Number.isFinite(answer.score)) answers[id] = answer;
			else if (question.type === 'choice' && Object.hasOwn(question.criteria, answer.choice)) answers[id] = answer;
		}
		return answers;
	}

	function recordFailure(role, error, purpose, attempt) {
		state[role].failures++;
		state[role].lastError = String(error?.message || error).slice(0, 300);
		circuit[role]++;
		log(`${role === 'jev' ? 'JEV' : 'Reasoner'} ${purpose} attempt ${attempt + 1} failed: ${state[role].lastError}`);
	}

	return {
		state,
		reasonerModel: settings.reasoner.model,
		jevModel: settings.jev.model,
		reasonerAvailable,
		jevAvailable,
		visionAvailable: () => reasonerAvailable() && settings.reasoner.vision,

		/** One chat completion: { message, text, toolCalls } or undefined. */
		async chat(messages, { tools, maxTokens = 4096, temperature = 0.2, signal, purpose = 'chat' } = {}) {
			for (let attempt = 0; attempt < 3 && reasonerAvailable(); attempt++) {
				signal?.throwIfAborted();
				state.reasoner.calls++;
				try {
					const body = await reasonerRequest({
						messages, max_tokens: maxTokens, temperature,
						...(tools?.length ? { tools, tool_choice: 'auto' } : {})
					}, signal);
					const usage = body?.usage ?? {};
					const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
					const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
					state.reasoner.inputTokens += inputTokens;
					state.reasoner.outputTokens += outputTokens;
					onUsage?.({ model: settings.reasoner.model, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: !usage.prompt_tokens && !usage.input_tokens });
					circuit.reasoner = 0;
					const message = body?.choices?.[0]?.message ?? {};
					const text = typeof message.content === 'string' ? message.content
						: Array.isArray(message.content) ? message.content.map(part => part?.text ?? '').join('') : '';
					return { message, text, toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [] };
				} catch (error) {
					if (signal?.aborted) throw signal.reason;
					recordFailure('reasoner', error, purpose, attempt);
					if (!retryable(error)) return undefined;
					await sleep(1500 * 2 ** attempt, signal);
				}
			}
			return undefined;
		},

		/** Chat expecting JSON; returns the parsed value or undefined. */
		async json(messages, options = {}) {
			const result = await this.chat(messages, options);
			return result ? parseModelJson(result.text) : undefined;
		},

		/** JEV decisions; returns an answers object or undefined. */
		async decide(context, questions, { signal } = {}) {
			for (let attempt = 0; attempt < 2 && jevAvailable(); attempt++) {
				signal?.throwIfAborted();
				state.jev.calls++;
				try {
					const answers = await jevRequest(context, questions, signal);
					circuit.jev = 0;
					return answers;
				} catch (error) {
					if (signal?.aborted) throw signal.reason;
					recordFailure('jev', error, 'decision', attempt);
					if (!retryable(error)) return undefined;
					await sleep(2000, signal);
				}
			}
			return undefined;
		}
	};
}
