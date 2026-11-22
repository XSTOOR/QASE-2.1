/**
 * Hybrid model routing. Each task type has a preferred model, a fallback and
 * an escalation rule; every routing decision is logged with its reason, the
 * model that actually answered and the tokens it cost.
 *
 *   reasoner (Opus-class): planning, exploration, investigation, visual review, report writing
 *   JEV:                   classification, verification, deduplication, prioritization
 *   escalation:            a JEV verdict in the uncertain band goes to the reasoner
 *   deterministic:         used when no model is available; recorded as such
 */

export const ROUTES = {
	planning: { prefer: 'reasoner', fallback: 'deterministic', why: 'Needs open-ended reasoning over the application graph.' },
	exploration: { prefer: 'reasoner', fallback: 'deterministic', why: 'Multi-step tool use in a live browser.' },
	investigation: { prefer: 'reasoner', fallback: 'deterministic', why: 'Diagnosing an unexpected observation needs reasoning.' },
	vision: { prefer: 'reasoner', fallback: 'deterministic', why: 'Screenshots need a multimodal model.' },
	report: { prefer: 'reasoner', fallback: 'deterministic', why: 'Writing the conclusion and fix guidance.' },
	verification: { prefer: 'jev', fallback: 'reasoner', why: 'Bounded yes/no and severity judgements are cheap and consistent on JEV.' },
	classification: { prefer: 'jev', fallback: 'reasoner', why: 'Bounded label decisions.' },
	escalation: { prefer: 'reasoner', fallback: 'jev', why: 'JEV was uncertain; a second opinion from the reasoner decides.' }
};

/** JEV probabilities in this band are escalated to the reasoner. */
export const ESCALATION_BAND = [0.35, 0.65];

const PURPOSE_TASK = { exploration: 'exploration', planning: 'planning', vision: 'vision', visual: 'vision', report: 'report', triage: 'verification', verification: 'verification', escalation: 'escalation', investigation: 'investigation', decision: 'verification' };

export function createRouter({ models, log: saved }) {
	const decisions = Array.isArray(saved?.decisions) ? saved.decisions : [];
	const tokens = saved?.tokens && typeof saved.tokens === 'object' ? saved.tokens : {};
	const record = entry => {
		decisions.push({ ts: Date.now(), ...entry });
		if (decisions.length > 400) decisions.splice(0, decisions.length - 400);
	};
	const available = model => model === 'reasoner' ? models.reasonerAvailable() : model === 'jev' ? models.jevAvailable() : true;

	/** Which model should do this task now, and why. */
	function choose(task) {
		const route = ROUTES[task] ?? ROUTES.investigation;
		if (available(route.prefer)) return { model: route.prefer, reason: route.why };
		if (available(route.fallback)) return { model: route.fallback, reason: `${route.prefer} unavailable (${lastError(route.prefer) ?? 'disabled or budget reached'}); fell back to ${route.fallback}.`, fallback: true };
		return { model: 'deterministic', reason: `No model available for ${task}; deterministic rules used.`, fallback: true };
	}
	const lastError = model => model === 'reasoner' ? models.state.reasoner.lastError : model === 'jev' ? models.state.jev.lastError : undefined;
	const snapshot = () => ({ r: models.state.reasoner.inputTokens + models.state.reasoner.outputTokens, j: models.state.jev.inputTokens + models.state.jev.outputTokens, rc: models.state.reasoner.calls, jc: models.state.jev.calls });
	const account = (task, before, outcome) => {
		const after = snapshot();
		const entry = tokens[task] ?? { reasonerTokens: 0, jevTokens: 0, reasonerCalls: 0, jevCalls: 0 };
		entry.reasonerTokens += after.r - before.r; entry.jevTokens += after.j - before.j;
		entry.reasonerCalls += after.rc - before.rc; entry.jevCalls += after.jc - before.jc;
		tokens[task] = entry;
		return { tokens: after.r - before.r + after.j - before.j, outcome };
	};

	/** Models proxy: every call is routed, logged and accounted by task. */
	const routed = {
		...models,
		state: models.state,
		reasonerAvailable: models.reasonerAvailable,
		jevAvailable: models.jevAvailable,
		visionAvailable: models.visionAvailable,
		async chat(messages, options = {}) {
			const task = PURPOSE_TASK[options.purpose] ?? 'investigation';
			const before = snapshot();
			const started = Date.now();
			const result = await models.chat(messages, options);
			const latencyMs = Date.now() - started;
			const modality = messages.some(message => Array.isArray(message.content) && message.content.some(part => part?.type === 'image_url')) ? 'image+text' : 'text';
			const cost = account(task, before);
			tokens[task].latencyMs = (tokens[task].latencyMs ?? 0) + latencyMs;
			if (modality !== 'text') tokens[task].imageCalls = (tokens[task].imageCalls ?? 0) + 1;
			// Exploration steps are many; log the first, then every tenth, plus failures.
			const steps = tokens[task].reasonerCalls;
			if (task !== 'exploration' || steps <= 1 || steps % 10 === 0 || !result) record({ task, model: result ? 'reasoner' : 'none', modelId: models.state.reasoner.model, modality, latencyMs, tools: Boolean(options.tools?.length), reason: ROUTES[task]?.why, outcome: result ? 'answered' : `failed: ${models.state.reasoner.lastError ?? 'unavailable'}`, tokens: cost.tokens, call: steps });
			return result;
		},
		async json(messages, options = {}) {
			const result = await routed.chat(messages, options);
			if (!result) return undefined;
			const { parseModelJson } = await import('./models.js');
			return parseModelJson(result.text);
		},
		async decide(context, questions, options = {}) {
			const before = snapshot();
			const result = await models.decide(context, questions, options);
			const cost = account('verification', before);
			record({ task: 'verification', model: result ? 'jev' : 'none', reason: ROUTES.verification.why, outcome: result ? `answered ${Object.keys(questions).length} questions` : `failed: ${models.state.jev.lastError ?? 'unavailable'}`, tokens: cost.tokens });
			return result;
		}
	};

	return {
		models: routed,
		choose,
		record,
		/** Log an explicit routing decision made by the engine (plan, escalation, fallback). */
		decide(task, detail = {}) {
			const choice = choose(task);
			record({ task, model: choice.model, reason: detail.reason ?? choice.reason, fallback: choice.fallback, ...detail.extra });
			return choice;
		},
		state: () => ({ decisions, tokens }),
		summary() {
			const byModel = {};
			for (const item of decisions) byModel[item.model] = (byModel[item.model] ?? 0) + 1;
			return { decisions: decisions.length, byModel, escalations: decisions.filter(item => item.task === 'escalation').length, fallbacks: decisions.filter(item => item.fallback).length, tokens };
		}
	};
}
