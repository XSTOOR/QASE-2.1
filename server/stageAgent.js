/**
 * The stage agent shared by the compliance (SQA) and Founder engines: one
 * CleanSlate SDK runtime driven by the reasoning model only. The host runs it
 * one stage at a time. Each stage advertises a small tool set, has a deadline
 * and a tool-call budget, and is complete only when its recording tool
 * succeeded. Between stages the SDK conversation is cleared and the next stage
 * starts from the durable state the host passes in, so context never grows
 * across a run.
 *
 * SDK tuning applied here:
 * - web research through the SDK's own retrieval (the operator's SearXNG
 *   first, then the anonymous hosted providers), recorded as sources;
 * - per-stage tool advertising, so the model never sees tools it must not use;
 * - a tool-call budget per stage that still lets the stage's finisher run;
 * - commands and file edits always refused;
 * - strict OpenAI-compatible gateways: no mid-conversation system messages;
 * - usage capture with estimates when the provider reports none.
 */
import { UNTRUSTED_CONTENT_RULE } from './untrustedContent.js';
import fs from 'node:fs';
import path from 'node:path';
import { CleanSlateNodeAgentRuntime, createNodeProviderConfiguration, getToolByName } from '@cleanslate/sdk';
import { attachUsageCapture } from './usageCapture.js';

const SILENT_LOGGER = { info() {}, debug() {}, warn() {}, error() {}, trace() {} };

/** Reasoning-model settings for a stage engine. `prefix` selects QASE_<PREFIX>_REASONING / _MAX_TURNS. */
export function stageModelSettings(settings, env = process.env, prefix = 'SQA') {
	return {
		model: settings.reasoner.model,
		baseUrl: settings.reasoner.baseUrl,
		apiKey: settings.reasoner.apiKey,
		enabled: settings.reasoner.enabled,
		reasoning: env[`QASE_${prefix}_REASONING`] || 'medium',
		maxTurns: Math.max(10, Math.min(200, Number(env[`QASE_${prefix}_MAX_TURNS`]) || 60)),
		// A SearXNG base URL. The older setting included /search; the SDK adds it itself.
		searchUrl: String(env[`QASE_${prefix}_SEARCH_URL`] || env.QASE_SQA_SEARCH_URL || '').trim().replace(/\/search\/?$/, '').replace(/\/+$/, '') || undefined
	};
}

/**
 * tools: custom SDK tool objects ({ name, description, parametersSchema, run }).
 * onPart(part): every SDK stream part (for activities and the live strip).
 * onUsage(usage): provider-reported or estimated token usage.
 */
export function createStageAgent({ session, model, tools, onPart = () => {}, onUsage = () => {}, onWebResult = () => {}, onToolResult = () => {}, rootDir }) {
	const rootPath = path.join(rootDir ?? path.join(process.cwd(), '.qase', 'workspaces'), session.id);
	fs.mkdirSync(rootPath, { recursive: true });
	const configuration = createNodeProviderConfiguration({ provider: 'custom', model: model.model, apiKey: model.apiKey, baseUrl: model.baseUrl, reasoningLevel: model.reasoning, maxTurns: model.maxTurns });
	// Web research through the SDK's own retrieval: the operator's SearXNG first when
	// configured, then the SDK's anonymous hosted providers.
	configuration.webSearch = { enabled: true, mode: 'freeOnly', searxngBaseUrl: model.searchUrl, includeAnonymousHostedProviders: true, maxResults: 8, timeoutMs: 25_000 };
	let allowed = new Set();
	let calls = 0;
	let budget = Infinity;
	let finisher;
	const runtime = new CleanSlateNodeAgentRuntime({
		rootPath, workspaceStorageHome: path.join(rootPath, '.state'), configuration, sessionId: session.id, logger: SILENT_LOGGER,
		browserHeadless: true,
		// This agent never runs commands or edits files.
		approveCommand: async () => false,
		approveTool: async ({ toolName }) => allowed.has(toolName) && (calls < budget || toolName === finisher)
	});
	// Strict OpenAI-compatible gateways reject a mid-conversation system message:
	// keep the original system instruction and append only the latest user turn.
	const sdkSession = runtime.agentSession;
	if (typeof sdkSession?.continueWithLatestUserMessage === 'function') sdkSession.continueWithTurn = sdkSession.continueWithLatestUserMessage.bind(sdkSession);
	const detachUsage = attachUsageCapture(runtime.cleanSlateService, { estimateMissing: true, onUsage });

	// Research tools come from the SDK; their results are recorded as sources.
	const research = ['web_search', 'web_fetch'].map(name => getToolByName(name)).filter(Boolean).map(tool => ({
		...tool,
		async run(input, context) {
			const result = await tool.run(input, context);
			try { onWebResult(tool.name, input, result); } catch { /* recording sources is best effort */ }
			return result;
		}
	}));
	const registered = [...research, ...tools].map(tool => ({
		...tool,
		async run(input, context) {
			calls++;
			if (calls > budget && tool.name !== finisher) return { success: false, code: 'STAGE_BUDGET_REACHED', error: `This step's tool budget is used up. Call ${finisher} now with what you have.` };
			let result;
			try { result = await tool.run(input, context); }
			catch (error) { result = { success: false, error: String(error?.message ?? error).split('\n')[0].slice(0, 300) }; }
			try { await onToolResult(tool.name, input, result); } catch { /* the activity feed is best effort */ }
			return result;
		}
	}));
	const headless = runtime.headlessRuntime;
	// Each stage advertises only its own tools.
	const advertise = names => {
		headless.options.tools = registered.filter(tool => names.has(tool.name));
		headless.toolsByName.clear();
		for (const tool of headless.options.tools) headless.toolsByName.set(tool.name, tool);
	};
	advertise(new Set());
	runtime.getToolDescriptions = () => '\nUse only the native tools supplied for this step.\n';

	return {
		/**
		 * Runs one stage. Resolves { done, error, turns } — never throws for model
		 * or tool failures, so the host can always fall back and continue.
		 * isDone(): whether the stage's recording tool has succeeded.
		 */
		async runStage({ task, tools: stageTools, finish, isDone, deadline, maxToolCalls = 30, signal, nudges = 2, nudge }) {
			allowed = new Set(stageTools);
			advertise(allowed);
			finisher = finish;
			calls = 0;
			budget = maxToolCalls;
			runtime.clearConversation();
			let error;
			let turns = 0;
			for (let attempt = 0; attempt <= nudges && !isDone() && Date.now() < deadline; attempt++) {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(new Error('stage deadline')), Math.max(1000, deadline - Date.now()));
				timer.unref?.();
				const stop = () => controller.abort(signal.reason);
				signal?.addEventListener('abort', stop, { once: true });
				const followUp = typeof nudge === 'function' ? nudge() : nudge;
				const prompt = attempt === 0 ? `${task}\n\n${UNTRUSTED_CONTENT_RULE}` : followUp || `You have not called ${finish} yet. Call ${finish} now with the best answer the evidence supports. Do not call other tools unless one is essential.`;
				try {
					for await (const part of runtime.run(prompt, controller.signal)) {
						if (part.type === 'assistant_turn_start') turns++;
						onPart(part);
						if (isDone() && part.type === 'assistant_turn_complete') break;
					}
				} catch (caught) {
					if (signal?.aborted) throw signal.reason ?? caught;
					if (!controller.signal.aborted) error = String(caught?.message ?? caught).split('\n')[0].slice(0, 300);
				} finally {
					clearTimeout(timer);
					signal?.removeEventListener('abort', stop);
				}
				if (error && /401|403|api key|unauthori[sz]ed|model .*not found|base url/i.test(error)) break; // not recoverable by retrying
			}
			allowed = new Set();
			return { done: isDone(), error, turns };
		},
		dispose() {
			detachUsage?.();
			try { runtime.dispose(); } catch { /* best effort */ }
		}
	};
}
