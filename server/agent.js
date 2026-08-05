import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALL_TOOLS, CleanSlateNodeAgentRuntime, createNodeProviderConfiguration } from '@cleanslate/sdk';
import { chromium } from 'playwright';
import { addActivity, addMessage, emit, listSessions, liveFor, setStatus, updateActivity } from './store.js';
import { attachBrowserBridge } from './browserBridge.js';
import { getConfig, getPublicConfig } from './config.js';
import { buildQaContext } from './prompt.js';
import { createQaTools } from './qaTools.js';
import { redact, secretNames } from './secrets.js';

/**
 * One CleanSlate runtime per session, narrowed to browser work.
 *
 * Three things happen here that the SDK does not do on its own: the tool
 * registry gains the two QA tools, the permission gate refuses everything that
 * is not browser automation, and the browser service is handed to the bridge so
 * the run can be watched.
 */

/**
 * How long a finished run keeps its browser alive, or 0 to keep it forever.
 *
 * Off by default: the browser belongs to the session, and a run that is paused
 * for an hour should come back to the same page it left. Pile-up is handled by
 * only ever running one browser at a time, not by timing them out.
 */
const BROWSER_IDLE_MS = Number(process.env.QASE_BROWSER_IDLE_MS ?? 0);
const MODEL_TIMEOUT_RETRIES = Math.max(0, Number(process.env.QASE_MODEL_TIMEOUT_RETRIES ?? 2));
const MODEL_TIMEOUT_RETRY_DELAY_MS = Math.max(0, Number(process.env.QASE_MODEL_TIMEOUT_RETRY_DELAY_MS ?? 1200));
const INCOMPLETE_RUN_CONTINUATIONS = Math.max(0, Number(process.env.QASE_INCOMPLETE_RUN_CONTINUATIONS ?? 2));

function isRetryableModelTimeout(error) {
	const message = error instanceof Error ? error.message : String(error);
	return /request timed out|provider activity for \d+ seconds/i.test(message);
}

/**
 * Point the SDK at Playwright's own Chromium.
 *
 * Left alone it launches with `channel: 'chrome'`, which drives the user's
 * installed Google Chrome — their real browser, their profile, their dock. A
 * testing agent should bring its own.
 */
function useBundledChromium() {
	if (process.env.CLEANSLATE_BROWSER_EXECUTABLE) {
		return;
	}
	try {
		const executable = chromium.executablePath();
		if (executable && fs.existsSync(executable)) {
			process.env.CLEANSLATE_BROWSER_EXECUTABLE = executable;
		} else {
			console.warn('  ! Playwright Chromium is not installed. Run: npm run install-browser');
		}
	} catch {
		// Fall back to whatever the SDK can find.
	}
}

const ALLOWED_TOOLS = new Set([
	'browser_open', 'browser_snapshot', 'browser_get_url', 'browser_wait', 'browser_screenshot',
	'browser_click', 'browser_hover', 'browser_fill', 'browser_check', 'browser_select',
	'browser_type', 'browser_key', 'browser_scroll', 'browser_diagnostics', 'browser_dialog',
	'browser_tabs', 'browser_new_tab', 'browser_select_tab', 'browser_close_tab',
	'update_todo', 'ask_question', 'report_finding', 'finish_qa_report'
]);

/** Tool name -> how the activity feed should announce it. */
const ACTIVITY_LABELS = {
	browser_open: 'Opened page',
	browser_snapshot: 'Read the page',
	browser_click: 'Clicked',
	browser_hover: 'Hovered',
	browser_fill: 'Filled field',
	browser_check: 'Toggled checkbox',
	browser_select: 'Selected option',
	browser_type: 'Typed',
	browser_key: 'Pressed key',
	browser_scroll: 'Scrolled',
	browser_wait: 'Waited',
	browser_screenshot: 'Captured screenshot',
	browser_diagnostics: 'Checked console and network',
	browser_get_url: 'Checked URL',
	browser_dialog: 'Handled dialog',
	browser_tabs: 'Listed tabs',
	browser_new_tab: 'Opened tab',
	browser_select_tab: 'Switched tab',
	browser_close_tab: 'Closed tab',
	update_todo: 'Updated the test plan',
	ask_question: 'Asked the user',
	report_finding: 'Filed a finding',
	finish_qa_report: 'Published the report'
};

function describeTarget(input) {
	if (!input || typeof input !== 'object') {
		return undefined;
	}
	if (input.url) {
		return input.url;
	}
	const label = input.name || input.text || input.label || input.placeholder ||
		input.testId || input.selector || input.role || input.elementId;
	if (label && input.value !== undefined) {
		return `${label} = ${input.value}`;
	}
	return label ?? (input.key || input.query);
}

/**
 * Where the browser actually is right now, or undefined when none is open.
 * Read fresh rather than remembered, because that is the whole point of it.
 */
function liveBrowserUrl(record) {
	try {
		const page = record.bridge?.service?.activePage;
		if (!page || page.isClosed()) {
			// Suspended between turns; the saved location is where it resumes.
			return record.bridge?.saved?.url;
		}
		const url = page.url();
		return /^about:/.test(url) ? record.bridge?.saved?.url : url;
	} catch {
		return undefined;
	}
}

/**
 * Closes a session's browser without discarding its runtime, so the
 * conversation survives but the Chromium process does not linger. The SDK
 * relaunches on the next browser tool call, and the bridge replays the session
 * into it.
 */
export async function closeBrowser(sessionId) {
	const record = liveFor(sessionId);
	clearTimeout(record.idleTimer);
	record.idleTimer = undefined;
	if (!record.bridge?.hasPage()) {
		return;
	}
	// suspend() captures cookies, local storage and the current URL first, so a
	// signed-in session is restored when the browser comes back.
	await record.bridge.suspend();
}

/** Closes every other session's browser, so only one is ever running. */
async function closeOtherBrowsers(keepSessionId) {
	await Promise.all(
		listSessions()
			.filter(summary => summary.id !== keepSessionId)
			.map(summary => (liveFor(summary.id).running ? undefined : closeBrowser(summary.id)))
	);
}

export function ensureRuntime(session) {
	const record = liveFor(session.id);
	if (record.runtime) {
		return record;
	}
	useBundledChromium();

	const settings = getConfig();
	const problem = getPublicConfig().problem;
	if (problem) {
		throw new Error(`${problem} Open Settings and add the endpoint details.`);
	}

	// The agent has no filesystem tools, but the runtime still wants a root. A
	// per-session scratch directory means even a slipped write stays contained.
	const rootPath = path.join(process.cwd(), '.qase', 'workspaces', session.id);
	fs.mkdirSync(rootPath, { recursive: true });

	const configuration = createNodeProviderConfiguration({
		provider: settings.provider,
		model: settings.model,
		apiKey: settings.apiKey,
		baseUrl: settings.baseUrl || undefined,
		reasoningLevel: settings.reasoning,
		maxTurns: Number(settings.maxTurns),
		// Azure keeps its endpoint and deployment in their own fields. The one
		// URL box in Settings feeds both, and the SDK recognises an /openai/v1
		// endpoint and talks to it over the OpenAI-compatible path.
		azureEndpoint: settings.baseUrl || undefined,
		azureDeploymentName: settings.model,
		azureApiVersion: settings.apiVersion || undefined
	});

	const runtime = new CleanSlateNodeAgentRuntime({
		rootPath,
		workspaceStorageHome: path.join(rootPath, '.state'),
		configuration,
		sessionId: session.id,
		browserHeadless: settings.headless !== false,
		// This agent never runs commands. The SDK refuses by default; being
		// explicit means the policy survives an SDK default changing.
		approveCommand: async () => false,
		approveTool: async ({ toolName }) => ALLOWED_TOOLS.has(toolName),
		additionalContext: () => buildQaContext(session, liveBrowserUrl(record))
	});

	// CleanSlate's default continuation appends a fresh system message before
	// every follow-up user turn. Strict Anthropic-compatible gateways reject a
	// mid-conversation system role. The SDK already exposes the protocol-safe
	// continuation we need: keep the original system instruction and append only
	// the latest user message. The per-turn browser context is still included in
	// that user message by buildPromptContext(), so no guidance is lost.
	const sdkSession = runtime.agentSession;
	if (typeof sdkSession?.continueWithLatestUserMessage === 'function') {
		sdkSession.continueWithTurn = sdkSession.continueWithLatestUserMessage.bind(sdkSession);
	}

	// The registry is fixed at construction, so the QA tools are registered
	// afterwards through the headless runtime that actually resolves them.
	const qaTools = createQaTools(session);
	const headless = runtime.headlessRuntime;
	headless.options.tools = [...ALL_TOOLS, ...qaTools];
	for (const tool of qaTools) {
		headless.toolsByName.set(tool.name, tool);
	}
	// The prompt's tool list is built from ALL_TOOLS; extend it to match reality.
	const describeTools = runtime.getToolDescriptions.bind(runtime);
	runtime.getToolDescriptions = () => `${describeTools()}${qaTools
		.map(tool => `- ${tool.name}: ${tool.description}\n  Parameters: ${JSON.stringify(tool.parametersSchema)}`)
		.join('\n')}\n`;

	// The SDK's stream reports tool_result but never tool_start, so the only
	// way to know a tool has begun — and to show it as running — is to wrap the
	// executor the loop calls.
	const originalExecute = headless.executeTool.bind(headless);
	headless.executeTool = async function* (toolName, input, toolCallId, signal) {
		record.onToolStart?.(toolName, input, toolCallId);
		yield* originalExecute(toolName, input, toolCallId, signal);
	};

	const service = headless.getToolContext().browserAutomationService;
	const bridge = attachBrowserBridge(session, service);

	record.runtime = runtime;
	record.bridge = bridge;
	record.dispose = () => {
		bridge.dispose();
		try {
			runtime.dispose();
		} catch {
			// Disposing a runtime that never opened a browser is not an error.
		}
	};
	return record;
}

/**
 * Drives one turn and translates the SDK's stream into dashboard events.
 * Returns when the model stops — either because the task is done or because it
 * asked a blocking question.
 */
export async function runTurn(session, { task, resumeAnswer, retryAttempt = 0, incompleteAttempt = 0 }) {
	const record = ensureRuntime(session);
	const { runtime, bridge } = record;

	if (record.running) {
		throw new Error('This session is already running. Stop it first.');
	}

	const controller = new AbortController();
	record.running = true;
	record.controller = controller;
	clearTimeout(record.idleTimer);
	record.idleTimer = undefined;
	session.pendingQuestion = undefined;
	setStatus(session, 'running');

	// A turn that paused for credentials or a question stops its frame timer in
	// finally. Resuming continues on the existing page and may never call
	// browser_open again, so restart the stream here instead of waiting for a
	// navigation tool that might not come. Capture immediately to replace the
	// stale pre-pause frame before the agent's next action is shown.
	if (bridge.hasPage()) {
		bridge.startFrames();
		void bridge.captureFrame();
	}

	// Only the session being worked on keeps a browser open.
	void closeOtherBrowsers(session.id);

	// Message-shaped placeholders the streamed text accumulates into. Reasoning
	// gets its own bubble so the transcript can show the agent's thinking
	// alongside what it actually said, and so both survive a page reload.
	let assistant;
	let thinking;
	let retryAfterTimeout = false;
	let continueIncompleteRun = false;

	const appendText = (content, kind) => {
		if (!content) {
			return;
		}
		if (!assistant) {
			assistant = addMessage(session, { role: 'agent', text: '', kind });
		}
		assistant.text += content;
		emit(session, 'message_delta', { id: assistant.id, content, kind });
	};

	// Reasoning is streamed for the live strip but never stored: it belongs to
	// the moment, not the transcript, and a reloaded page should show what the
	// agent said rather than what it was mulling over an hour ago.
	const appendThinking = content => {
		if (!content) {
			return;
		}
		thinking ??= `think-${Date.now()}`;
		emit(session, 'message_delta', { id: thinking, content, role: 'thinking' });
	};

	const closeThinking = () => {
		if (!thinking) {
			return;
		}
		emit(session, 'message_done', { id: thinking, role: 'thinking' });
		thinking = undefined;
	};

	const openActivities = new Map();

	const beginActivity = (toolName, input, toolCallId) => {
		closeThinking();
		const safeInput = redact(session.id, input);
		const activity = addActivity(session, {
			id: toolCallId,
			type: 'tool',
			toolName,
			label: ACTIVITY_LABELS[toolName] ?? toolName,
			detail: describeTarget(safeInput),
			input: safeInput,
			status: 'running'
		});
		openActivities.set(toolCallId ?? activity.id, activity.id);
		if (toolName === 'browser_open' && typeof input?.url === 'string') {
			session.targetUrl ??= input.url;
		}
		return activity;
	};

	record.onToolStart = beginActivity;

	try {
		const stream = resumeAnswer === undefined
			? runtime.run(task, controller.signal)
			: runtime.resumePendingQuestion(resumeAnswer, controller.signal);

		for await (const part of stream) {
			switch (part.type) {
				case 'chat_text':
					// Anything it says out loud ends the thought that preceded it.
					closeThinking();
					appendText(part.content, part.kind);
					break;

				case 'chat_text_reset':
					assistant = undefined;
					break;

				case 'reasoning':
					appendThinking(part.content);
					break;

				case 'reasoning_reset':
					closeThinking();
					break;

				case 'assistant_turn_start':
					// Each model turn is a fresh chat bubble.
					assistant = undefined;
					closeThinking();
					emit(session, 'turn', { turnId: part.turnId, index: part.turnIndex });
					break;

				case 'context_usage':
					session.contextUsage = {
						percentage: part.percentage,
						used: part.estimatedInputTokens,
						window: part.contextWindowTokens
					};
					emit(session, 'context', { context: session.contextUsage });
					break;

				case 'tool_start':
					// Not emitted by the SDK today; handled here in case it is.
					if (!openActivities.has(part.toolCallId)) {
						beginActivity(part.toolName, part.input, part.toolCallId);
					}
					break;

				case 'tool_result': {
					// A rejected or malformed call never reaches the executor, so
					// its result is the first thing seen of it.
					if (!openActivities.has(part.toolCallId)) {
						beginActivity(part.toolName, part.input, part.toolCallId);
					}
					const id = openActivities.get(part.toolCallId) ?? part.toolCallId;
					const result = redact(session.id, part.result);
					const ok = result?.success !== false;
					updateActivity(session, id, {
						status: ok ? 'done' : 'failed',
						error: ok ? undefined : (result?.error ?? result?.message),
						summary: summariseResult(part.toolName, result)
					});
					openActivities.delete(part.toolCallId);

					if (part.toolName === 'update_todo' && ok) {
						session.todos = normaliseTodos(part.result, session.todos);
						emit(session, 'todos', { todos: session.todos });
					}
					if (part.toolName === 'browser_open' && ok && result?.url) {
						bridge.startFrames();
					}
					break;
				}

				case 'task_complete':
					emit(session, 'task_complete', { result: redact(session.id, part.result) });
					break;

				default:
					break;
			}
		}

		// The loop ends either because the work is done or because ask_question
		// suspended it. Only the runtime knows which.
		const pending = runtime.getPendingQuestion();
		if (pending) {
			session.pendingQuestion = {
				toolCallId: pending.toolCallId,
				...normaliseQuestion(pending.question)
			};
			emit(session, 'question', { question: session.pendingQuestion });
			setStatus(session, 'awaiting_input');
		} else if (session.report) {
			setStatus(session, 'done');
		} else if (!session.targetUrl) {
			// A greeting or prose-only response can ask for the target without
			// invoking ask_question. No QA run has started yet, so continuing
			// automatically would only repeat the request and lock the composer.
			setStatus(session, 'awaiting_input', 'Waiting for a target URL.');
		} else if (incompleteAttempt < INCOMPLETE_RUN_CONTINUATIONS) {
			// CleanSlate may host-finalize a prose-only model turn even though the
			// QA-specific completion tool was never called. That is a pause, not an
			// idle run: keep the visible status active and immediately resume after
			// cleanup so the agent finishes the remaining plan without user nudges.
			continueIncompleteRun = true;
			setStatus(
				session,
				'running',
				`The agent paused before publishing its report. Continuing automatically (${incompleteAttempt + 1}/${INCOMPLETE_RUN_CONTINUATIONS})…`
			);
		} else {
			const message = 'The agent paused repeatedly before publishing the final QA report. Send "continue" to resume this run.';
			addMessage(session, { role: 'system', text: message, kind: 'error' });
			setStatus(session, 'error', message);
		}
	} catch (error) {
		if (controller.signal.aborted) {
			setStatus(session, 'idle', 'Stopped by user.');
		} else if (retryAttempt < MODEL_TIMEOUT_RETRIES && isRetryableModelTimeout(error)) {
			retryAfterTimeout = true;
			setStatus(
				session,
				'running',
				`The model response timed out. Retrying automatically (${retryAttempt + 1}/${MODEL_TIMEOUT_RETRIES})…`
			);
		} else {
			const message = error instanceof Error ? error.message : String(error);
			addMessage(session, { role: 'system', text: message, kind: 'error' });
			setStatus(session, 'error', message);
		}
	} finally {
		closeThinking();
		record.running = false;
		record.controller = undefined;
		session.secretNames = secretNames(session.id);
		// One last frame so the panel shows where the run actually finished.
		void bridge.captureFrame();
		bridge.stopFrames();

		// The browser stays with the session unless a timeout was asked for.
		clearTimeout(record.idleTimer);
		record.idleTimer = undefined;
		if (BROWSER_IDLE_MS > 0) {
			// A paused run is likely to continue, so it waits proportionally longer.
			const idleMs = session.status === 'awaiting_input' ? BROWSER_IDLE_MS * 3 : BROWSER_IDLE_MS;
			record.idleTimer = setTimeout(() => {
				void closeBrowser(session.id);
			}, idleMs);
			record.idleTimer.unref?.();
		}
	}

	if (continueIncompleteRun) {
		return runTurn(session, {
			task: 'Continue the unfinished QA run now. Do not stop with a progress update or a description of what you will do next. Immediately use the next required tool, complete every remaining test-plan item without repeating finished work, and call finish_qa_report when the run is complete. Only call ask_question if user input is genuinely required.',
			incompleteAttempt: incompleteAttempt + 1
		});
	}

	if (retryAfterTimeout) {
		if (MODEL_TIMEOUT_RETRY_DELAY_MS > 0) {
			await new Promise(resolve => setTimeout(resolve, MODEL_TIMEOUT_RETRY_DELAY_MS));
		}
		return runTurn(session, {
			task: 'Continue from the latest transcript and browser state. The previous model request timed out after the last successful step. Inspect the current state before acting, do not repeat completed or irreversible actions, and finish the remaining test plan.',
			retryAttempt: retryAttempt + 1,
			incompleteAttempt
		});
	}
}

function summariseResult(toolName, result) {
	if (!result || typeof result !== 'object') {
		return undefined;
	}
	if (toolName === 'browser_diagnostics') {
		const errors = (result.console ?? []).filter(entry => entry.level === 'error').length;
		const failed = (result.network ?? []).filter(entry => entry.statusCode >= 400 || entry.error).length;
		return `${errors} console error(s), ${failed} failed request(s)`;
	}
	if (toolName === 'browser_snapshot') {
		return `${result.elements?.length ?? 0} elements on ${result.title || result.url || 'page'}`;
	}
	if (result.recorded) {
		return result.recorded;
	}
	if (result.url) {
		return result.title ? `${result.title} — ${result.url}` : result.url;
	}
	return undefined;
}

/** The todo tool accepts several shapes; the dashboard wants exactly one. */
function normaliseTodos(result, previous) {
	const raw = result?.items ?? result?.todos ?? result?.to_do ?? result?.checklist;
	if (!Array.isArray(raw)) {
		return previous;
	}
	const statusOf = value => {
		const status = String(value ?? '').toLowerCase();
		if (status === 'doing' || status === 'in_progress') {
			return 'in_progress';
		}
		if (status === 'done' || status === 'completed' || status === 'x') {
			return 'completed';
		}
		return 'pending';
	};
	return raw.map(item => {
		if (typeof item === 'string') {
			const match = item.match(/^\s*\[(.)\]\s*(.*)$/);
			return match
				? { text: match[2], status: match[1] === 'x' ? 'completed' : match[1] === '/' ? 'in_progress' : 'pending' }
				: { text: item, status: 'pending' };
		}
		return { text: item?.content ?? item?.text ?? '', status: statusOf(item?.status) };
	}).filter(item => item.text);
}

/** Flattens the ask_question payload into what the chat panel renders. */
function normaliseQuestion(question) {
	const payload = question?.planning_question ?? question ?? {};
	const options = Array.isArray(payload.options)
		? payload.options.map(option => (typeof option === 'string' ? { label: option } : option)).filter(Boolean)
		: [];
	const text = payload.question ?? '';
	return {
		question: text,
		summary: question?.summary,
		options,
		allowCustom: payload.allowCustom !== false,
		customLabel: payload.customLabel,
		placeholder: payload.placeholder,
		// Credential questions get a dedicated, non-echoing form in the UI.
		credentialLike: looksLikeCredentialRequest(text, options)
	};
}

const CREDENTIAL_HINT = /\b(credential|password|passcode|username|user name|login|log in|sign in|sign-in|email and password|account)\b/i;

function looksLikeCredentialRequest(text, options) {
	const haystack = [text, ...options.map(option => option.label ?? '')].join(' ');
	return CREDENTIAL_HINT.test(haystack);
}
