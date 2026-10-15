/**
 * Agent-generated test cases (Phase: autogen).
 *
 * When a QA run completes with a published report, the agent derives reusable
 * test cases from what the run actually covered (plan, findings, target,
 * environment) and adds them to the existing Test Cases store. Manual creation
 * is untouched; generated records are marked `source: 'auto'` with a
 * `sourceRunId` so the UI can badge and filter them.
 *
 * Two generation paths, tried in order:
 *  1. LLM — one OpenAI-compatible chat completion using the same provider
 *     settings the QA agent runs with (server/config.js). The model returns a
 *     JSON array of case drafts; entries are validated and clamped to the same
 *     limits normalizeTestCaseInput enforces.
 *  2. Deterministic fallback — when no key is configured or the LLM fails,
 *     template cases are built from the plan todos and findings, so the feature
 *     works without any model credentials.
 *
 * Generation is best-effort: it must never fail a run or throw into the bus.
 */

const DEFAULT_MAX_CASES = 5;
const DEFAULT_LLM_TIMEOUT_MS = 30_000;
const TITLE_MAX = 300;
const DESCRIPTION_MAX = 4000;
const EXPECTED_MAX = 4000;
const STEP_MAX = 1000;
const MAX_STEPS = 50;
const MAX_TAGS = 12;

export class TestCaseAutogenError extends Error {
	constructor(message, code = 'QASE_AUTOGEN_FAILED') {
		super(message);
		this.name = 'TestCaseAutogenError';
		this.code = code;
	}
}

export function autogenSettingsFromEnv(environment = process.env) {
	const enabled = environment.QASE_AUTOGEN_TESTCASES === undefined
		? true
		: !['false', '0', 'off', 'no'].includes(String(environment.QASE_AUTOGEN_TESTCASES).toLowerCase());
	const maxCasesRaw = Number(environment.QASE_AUTOGEN_MAX_CASES);
	const maxCases = Number.isFinite(maxCasesRaw) && maxCasesRaw > 0
		? Math.min(20, Math.floor(maxCasesRaw))
		: DEFAULT_MAX_CASES;
	const fromCases = ['true', '1', 'on', 'yes'].includes(
		String(environment.QASE_AUTOGEN_FROM_CASES ?? '').toLowerCase());
	const timeoutRaw = Number(environment.QASE_AUTOGEN_TIMEOUT_MS);
	const llmTimeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
		? Math.min(120_000, Math.floor(timeoutRaw))
		: DEFAULT_LLM_TIMEOUT_MS;
	return { enabled, maxCases, fromCases, llmTimeoutMs };
}

function clampText(value, max) {
	const text = String(value ?? '').replace(/\s+/g, ' ').trim();
	return text.slice(0, max);
}

function clampSteps(steps) {
	if (!Array.isArray(steps)) return [];
	return steps
		.map((step) => clampText(step, STEP_MAX))
		.filter(Boolean)
		.slice(0, MAX_STEPS);
}

function clampTags(tags) {
	if (!Array.isArray(tags)) return [];
	return [...new Set(tags.map((tag) => clampText(tag, 40).toLowerCase()).filter(Boolean))]
		.slice(0, MAX_TAGS);
}

/** Validate + clamp a single draft. Returns null when unrecoverable. */
export function normalizeGeneratedCase(draft, { runTag, sourceRunId, sourceUrl }) {
	if (!draft || typeof draft !== 'object') return null;
	const title = clampText(draft.title, TITLE_MAX);
	if (!title) return null;
	const description = clampText(draft.description, DESCRIPTION_MAX) || null;
	const expected = clampText(draft.expected, EXPECTED_MAX) || null;
	const steps = clampSteps(draft.steps);
	const extraTags = clampTags(draft.tags).filter((tag) => tag !== 'auto' && tag !== runTag);
	const tags = [...new Set(['auto', runTag, ...extraTags])].slice(0, MAX_TAGS);
	const environmentIds = Array.isArray(draft.environmentIds)
		? [...new Set(draft.environmentIds.map((id) => String(id).trim()).filter(Boolean))]
		: [];
	return {
		title,
		description,
		expected,
		steps,
		tags,
		environmentIds,
		source: 'auto',
		sourceRunId,
		sourceUrl: sourceUrl ?? null
	};
}

/** Pull a JSON array out of a model response (plain array or fenced/embedded). */
export function extractCaseDrafts(text) {
	if (typeof text !== 'string' || !text.trim()) return [];
	const attempts = [];
	const trimmed = text.trim();
	// Strip markdown fences if present.
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) attempts.push(fenced[1]);
	attempts.push(trimmed);
	// Fall back to the outermost bracketed slice.
	const firstArray = trimmed.indexOf('[');
	const lastArray = trimmed.lastIndexOf(']');
	if (firstArray !== -1 && lastArray > firstArray) attempts.push(trimmed.slice(firstArray, lastArray + 1));
	for (const candidate of attempts) {
		try {
			const parsed = JSON.parse(candidate);
			if (Array.isArray(parsed)) return parsed;
			if (parsed && Array.isArray(parsed.cases)) return parsed.cases;
		} catch { /* next candidate */ }
	}
	return [];
}

function sessionRunTag(session) {
	const id = String(session?.id ?? '');
	return id ? `run-${id.slice(0, 8)}`.toLowerCase() : 'auto-run';
}

/** Everything the generator needs to know about the finished run. */
export function buildGenerationContext(session) {
	const report = session?.report ?? null;
	const todos = Array.isArray(session?.todos) ? session.todos : [];
	const findings = Array.isArray(session?.findings) ? session.findings : [];
	const environmentSnapshot = session?.environmentSnapshot ?? null;
	const deviceLabel = environmentSnapshot
		? `${environmentSnapshot.device ?? environmentSnapshot.envId ?? 'device'} · ${environmentSnapshot.browser ?? ''}`.trim()
		: (session?.device && session.device !== 'desktop' ? String(session.device) : '');
	return {
		sessionId: String(session?.id ?? ''),
		targetUrl: session?.targetUrl ?? report?.targetUrl ?? '',
		verdict: report?.verdict ?? null,
		summary: report?.summary ?? '',
		todos: todos
			.filter((todo) => todo && typeof todo.text === 'string')
			.map((todo) => ({ text: clampText(todo.text, 300), completed: todo.status === 'done' ?? todo.completed === true })),
		findings: findings.map((finding) => ({
			title: clampText(finding.title, 300),
			severity: String(finding.severity ?? 'normal').toLowerCase(),
			actual: clampText(finding.actual, 500) || null,
			expected: clampText(finding.expected, 500) || null,
			steps: clampSteps(finding.steps)
		})),
		deviceLabel,
		sourceCaseNumber: session?.testCaseSnapshot?.caseNumber ?? null
	};
}

const SYSTEM_PROMPT = [
	'You generate reusable QA test cases from a completed exploratory test run.',
	'Return ONLY a JSON object: {"cases":[...]} where each case is',
	'{"title","description","steps":[..],"expected","tags":[..]}.',
	'Return at most the requested number of cases. Steps are short imperative',
	'strings. Tags are lowercase. Never invent functionality that the run did',
	'not cover; generalize what it observed into reusable checks.'
].join(' ');

function userPrompt(context, maxCases) {
	const lines = [
		`Target URL: ${context.targetUrl || '(unknown)'}`,
		`Verdict: ${context.verdict ?? 'unknown'}`,
		context.summary ? `Summary: ${context.summary}` : '',
		context.deviceLabel ? `Executed on: ${context.deviceLabel}` : '',
		context.todos.length ? `Plan covered:\n${context.todos.map((t) => `- ${t.text}`).join('\n')}` : '',
		context.findings.length
			? `Findings:\n${context.findings.map((f) => `- [${f.severity}] ${f.title}${f.actual ? ` — actual: ${f.actual}` : ''}`).join('\n')}`
			: '',
		`Generate up to ${maxCases} reusable test cases a regression suite should keep.`
	];
	return lines.filter(Boolean).join('\n\n');
}

function chatUrl(baseUrl) {
	const base = String(baseUrl ?? '').replace(/\/+$/, '');
	return `${base}/chat/completions`;
}

function withTimeout(promise, timeoutMs, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new TestCaseAutogenError(`${label} timed out.`, 'QASE_AUTOGEN_TIMEOUT')), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** One OpenAI-compatible completion. Returns draft array; throws on failure. */
async function generateDraftsWithLlm({ config, fetchImpl, context, maxCases, timeoutMs }) {
	const apiKey = config?.apiKey;
	if (!apiKey) throw new TestCaseAutogenError('No API key configured.', 'QASE_AUTOGEN_NO_KEY');
	if (config?.provider === 'bedrock') {
		// Bedrock uses AWS signatures, not a plain bearer chat endpoint — skip.
		throw new TestCaseAutogenError('Provider does not expose a chat endpoint.', 'QASE_AUTOGEN_NO_KEY');
	}
	const baseUrl = config?.baseUrl;
	if (!baseUrl) throw new TestCaseAutogenError('No model endpoint configured.', 'QASE_AUTOGEN_NO_KEY');
	const model = config?.model;
	if (!model) throw new TestCaseAutogenError('No model configured.', 'QASE_AUTOGEN_NO_KEY');

	const request = fetchImpl(chatUrl(baseUrl), {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`
		},
		body: JSON.stringify({
			model,
			messages: [
				{ role: 'system', content: SYSTEM_PROMPT },
				{ role: 'user', content: userPrompt(context, maxCases) }
			],
			max_tokens: 2000,
			temperature: 0.2
		}),
		signal: AbortSignal.timeout(timeoutMs)
	});
	const response = await withTimeout(request, timeoutMs, 'Model endpoint');
	if (!response.ok) {
		throw new TestCaseAutogenError(`Model endpoint returned ${response.status}.`, 'QASE_AUTOGEN_LLM_HTTP');
	}
	const payload = await response.json();
	const content = payload?.choices?.[0]?.message?.content;
	return extractCaseDrafts(typeof content === 'string' ? content : '');
}

/**
 * Deterministic fallback: 1 case per top todo, 1 regression case per
 * critical/high finding, capped at maxCases.
 */
export function buildFallbackCases(context, maxCases) {
	const cases = [];
	const seen = new Set();
	const push = (title, description, steps, expected, tags) => {
		const key = title.toLowerCase();
		if (seen.has(key) || cases.length >= maxCases) return;
		seen.add(key);
		cases.push({ title, description, steps, expected, tags });
	};
	for (const todo of context.todos.slice(0, maxCases)) {
		push(
			`Regression: ${todo.text}`,
			`Automatically derived from QA run coverage of "${todo.text}" on ${context.targetUrl || 'the target'}.`
				+ (context.deviceLabel ? ` Executed on ${context.deviceLabel}.` : ''),
			[
				`Open ${context.targetUrl || 'the target application'}.`,
				`Repeat the covered check: ${todo.text}.`,
				'Compare the observed behavior with the expected result.'
			],
			'The covered behavior works as expected, matching the outcome recorded by the original run.',
			['regression', 'autogen']
		);
	}
	for (const finding of context.findings.slice(0, Math.max(1, maxCases - cases.length))) {
		if (!['critical', 'high'].includes(finding.severity)) continue;
		push(
			`Verify fix: ${finding.title}`,
			`Regression guard for a ${finding.severity}-severity finding from QA run coverage.`
				+ (finding.actual ? ` Observed: ${finding.actual}` : ''),
			finding.steps.length ? finding.steps : [
				`Open ${context.targetUrl || 'the target application'}.`,
				`Reproduce the original issue: ${finding.title}.`,
				'Confirm the issue no longer occurs.'
			],
			finding.expected ?? 'The reported issue no longer reproduces.',
			['regression', 'bug', finding.severity]
		);
	}
	return cases;
}

/**
 * Create the autogen engine. `generateForSession(session)` returns
 * { created: [...], skipped: 'reason' | undefined }.
 */
export function createTestCaseAutogen({
	testCases,
	config,
	fetchImpl = fetch,
	settings = autogenSettingsFromEnv(),
	logger = () => {},
	getExistingCases = null
}) {
	const runTagFor = sessionRunTag;

	async function listExisting() {
		if (getExistingCases) return getExistingCases();
		try { return await testCases.list({}); } catch { return []; }
	}

	async function generateForSession(session) {
		if (!settings.enabled) return { created: [], skipped: 'disabled' };
		if (!session || !session.report) return { created: [], skipped: 'no-report' };
		// The report commit fires before the run's terminal status transition,
		// so status is informational only — a published report is the trigger.
		// Explicitly non-complete states (stopped/errored before a report exists)
		// are already excluded by the no-report check above.
		if (['idle', 'stopped'].includes(session.status)) {
			return { created: [], skipped: 'run-not-complete' };
		}
		// Runs launched from a test case already have their scenario recorded;
		// regenerating it would duplicate the author's work.
		if (session.testCaseSnapshot && !settings.fromCases) {
			return { created: [], skipped: 'from-test-case' };
		}

		const context = buildGenerationContext(session);
		const hasMaterial = context.todos.length > 0 || context.findings.length > 0 || context.verdict;
		if (!hasMaterial) return { created: [], skipped: 'empty-run' };

		const runTag = runTagFor(session);
		const existing = await listExisting();
		const existingTitles = new Set(
			existing
				.filter((record) => !record.deleted && record.sourceRunId === context.sessionId)
				.map((record) => String(record.title).trim().toLowerCase()));
		// Same run generating twice — nothing to add.
		if (existing.some((record) => !record.deleted && record.sourceRunId === context.sessionId && record.source === 'auto')) {
			return { created: [], skipped: 'already-generated' };
		}

		let drafts = [];
		let path = 'llm';
		try {
			drafts = await generateDraftsWithLlm({
				config, fetchImpl, context, maxCases: settings.maxCases, timeoutMs: settings.llmTimeoutMs
			});
		} catch (error) {
			logger(`[autogen] LLM path failed (${error?.code ?? error?.message}); using fallback templates.`);
			path = 'fallback';
		}
		if (!drafts.length) path = 'fallback';
		if (path === 'fallback') {
			drafts = buildFallbackCases(context, settings.maxCases);
		}
		if (!drafts.length) return { created: [], skipped: 'nothing-to-generate' };

		const sourceUrl = context.targetUrl || null;
		const created = [];
		for (const draft of drafts.slice(0, settings.maxCases)) {
			const normalized = normalizeGeneratedCase(draft, { runTag, sourceRunId: context.sessionId, sourceUrl });
			if (!normalized) continue;
			const titleKey = normalized.title.toLowerCase();
			if (existingTitles.has(titleKey)) continue;
			existingTitles.add(titleKey);
			try {
				const record = await testCases.create(normalized);
				created.push(record);
			} catch (error) {
				logger(`[autogen] could not store case "${normalized.title}": ${error?.message ?? error}`);
			}
		}
		if (created.length) {
			logger(`[autogen] ${created.length} case(s) generated from run ${context.sessionId} (${path}).`);
		}
		return { created, path };
	}

	return { generateForSession, settings };
}
