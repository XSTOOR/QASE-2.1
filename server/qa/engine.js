/**
 * QASE QA engine — adaptive architecture (state version 2, architecture "adaptive").
 *
 * The engine observes the application before it plans anything:
 *
 *   observe   open the target; record DOM features, accessibility snapshot,
 *             console/network, sign-in entry points and a screenshot
 *   signin    detect authentication; use the vault account (asked for once via
 *             the secure card), handle two-step sign-in, verify the session
 *   discover  crawl public pages (signed-out context) and the signed-in area
 *             into the application graph; re-authenticate on session expiry
 *   plan      scenarios from graph × capability registry, plus journeys the
 *             reasoner proposes from the graph (deterministic fallback)
 *   execute   run scenarios by priority; every scenario is checkpointed; the
 *             plan is revised whenever execution adds pages, features or roles
 *   triage    merge, verify with JEV, escalate uncertain verdicts to the reasoner
 *   publish   capability coverage (140 categories), completion gate, report
 *
 * Models: the reasoner (planning, exploration, visual review, report writing)
 * and JEV (verification) are called through the router, which logs every
 * routing decision and the tokens it cost. CleanSlate is not used.
 *
 * Completion: the run is "complete" only when the deterministic completion
 * gate holds; a model's claim that testing is finished never ends the plan.
 * A user stop, budget end or unexpected error still publishes a partial
 * report with every unexecuted scenario marked "not executed" and why.
 */
import { randomUUID } from 'node:crypto';
import { createArtifactStore } from '../artifactStore.js';
import { redact } from '../secrets.js';
import { createQaBrowser, primaryProfile, VIEWPORTS } from './browser.js';
import { createQaModels, qaModelSettings } from './models.js';
import { candidate, severityRank } from './findings.js';
import { auditPage } from './detectors/page.js';
import { testInteractions, testHoverMenus, testReducedMotion } from './detectors/interactions.js';
import { testForms } from './detectors/forms.js';
import { auditOrigin, auditPageSecurity, probeInjection, probeRedirects, discoverAuthRoutes } from './detectors/security.js';
import { createFrontier, checkLinks, normalizeUrl } from './crawl.js';
import { explore } from './explorer.js';
import { reviewVisuals } from './visualReview.js';
import { triage } from './triage.js';
import { signIn, hasLoginForm, detectAuth, isSignInPage } from './signin.js';
import { accountQuestion, waitForAccount } from './accountQuestion.js';
import { buildReport, refineWithReasoner } from './report.js';
import { createAppGraph, observeFeatures } from './appGraph.js';
import { createPlan, scenariosFromGraph, proposeJourneys, fallbackJourney, revisePlan, nextScenario, recoverInterrupted, closeOutPlan, unitOutcomes, planSummary } from './planner.js';
import { capabilityCoverage, summarizeCoverage, CAPABILITY_COUNT } from './capabilities.js';
import { createRouter, ESCALATION_BAND } from './router.js';
import { evaluateCompletion } from './completionGate.js';
import { EXECUTORS } from './executors.js';
import { dismissOverlays } from './overlays.js';
import { discoverViews, routeTemplate } from './uiCrawl.js';

export const ENGINE_VERSION = 2;
export const ENGINE_ARCHITECTURE = 'adaptive';

/** Fallback guidance when neither a detector nor the reasoner supplied one. */
const DEFAULT_FIX = {
	functional: 'Reproduce with the steps above, find the handler or data path that produces the wrong result, fix it, and add a regression test for this journey.',
	navigation: 'Fix the route or link target and add a test that follows the link.',
	forms: 'Fix the form\'s validation and feedback for this input, both in the browser and on the server.',
	layout: 'Inspect the element at the reported viewport, fix the CSS (sizing, positioning or stacking) and verify at every breakpoint.',
	visual: 'Inspect the screenshot area, fix the component styling and verify at every breakpoint.',
	animation: 'Review the component\'s transition/animation start and end states and stacking during the animation.',
	responsive: 'Fix the layout at this breakpoint with flexible sizing and verify on real device widths.',
	accessibility: 'Fix the semantics (roles, names, labels, focus handling) and verify with a screen reader and keyboard.',
	content: 'Correct the content or the data binding that renders it.',
	security: 'Fix the weakness on the server side and add a regression test for it.',
	performance: 'Profile the page, remove the bottleneck and re-measure.'
};

const STAGES = [
	['observe', 'Open the app and observe it'],
	['signin', 'Sign in and verify the session'],
	['discover', 'Map pages, features and roles'],
	['plan', 'Plan scenarios from what was found'],
	['execute', 'Run the plan (revised as it learns)'],
	['triage', 'Verify findings (JEV, escalate to reasoner)'],
	['publish', 'Coverage, completion gate and report']
];
const STAGE_SHARE = { observe: 5, signin: 8, discover: 22, plan: 3, execute: 56, triage: 5, publish: 1 };
const STAGE_IDS = STAGES.map(([id]) => id);
const label = id => STAGES.find(([key]) => key === id)?.[1] ?? id;

const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const pathOf = url => { try { const parsed = new URL(url); return `${parsed.pathname}${parsed.search}` || '/'; } catch { return url; } };
const LOGIN_PATH = /\/(log-?in|sign-?in|auth\/login|session\/new)(\/|$|\?)/i;

/** "5 possible issues (3 accessibility, 2 layout)" for the narration. */
export function describeCandidates(list) {
	if (!list.length) return 'nothing suspicious';
	const counts = {};
	for (const item of list) counts[item.category] = (counts[item.category] ?? 0) + 1;
	const parts = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([category, count]) => `${count} ${category}`);
	return `${plural(list.length, 'possible issue')} (${parts.join(', ')})`;
}

const positive = (value, fallback, max) => {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? Math.min(max, Math.floor(number)) : fallback;
};

export function engineOptions(env = process.env) {
	return {
		budgetMs: positive(env.QASE_QA_MAX_MINUTES, 25, 120) * 60_000,
		maxPages: positive(env.QASE_QA_MAX_PAGES, 12, 60),
		secondaryPages: positive(env.QASE_QA_VIEWPORT_PAGES, 5, 30),
		interactionPages: positive(env.QASE_QA_INTERACTION_PAGES, 4, 20),
		triggersPerPage: positive(env.QASE_QA_TRIGGERS_PER_PAGE, 8, 30),
		exploreSteps: positive(env.QASE_QA_EXPLORE_STEPS, 30, 120),
		journeys: positive(env.QASE_QA_JOURNEYS, 6, 12),
		uiScreens: positive(env.QASE_QA_UI_SCREENS, 12, 40),
		visualShots: positive(env.QASE_QA_VISUAL_SHOTS, 8, 30),
		maxArtifacts: positive(env.QASE_QA_MAX_ARTIFACTS, 120, 500),
		maxScenarios: positive(env.QASE_QA_MAX_SCENARIOS, 80, 300),
		maxReauth: positive(env.QASE_QA_MAX_REAUTH, 3, 10),
		// How long the agent waits for the owner to answer the sign-in question.
		credentialWaitMs: positive(env.QASE_QA_CREDENTIAL_WAIT_MINUTES, 10, 120) * 60_000,
		askForCredentials: env.QASE_QA_ASK_CREDENTIALS !== 'false'
	};
}

export function isQaEngineSession(session) {
	return session?.mode === 'qa';
}

/** Public, bounded projection of engine state for the dashboard. */
export function publicQaState(session) {
	const state = session.hybrid;
	if (state?.version !== ENGINE_VERSION) return undefined;
	const plan = state.plan ?? { scenarios: [], revisions: [] };
	return {
		version: state.version, architecture: state.architecture, engine: state.engine, status: state.status, phase: state.phase,
		phases: STAGES.map(([id, text]) => ({ id, label: text, status: state.phases?.[id]?.status ?? 'pending', detail: state.phases?.[id]?.detail, startedAt: state.phases?.[id]?.startedAt, endedAt: state.phases?.[id]?.endedAt })),
		coverage: state.coverage, limitations: state.limitations, models: state.models,
		candidates: state.candidates?.length ?? 0, startedAt: state.startedAt, updatedAt: state.updatedAt,
		signedIn: Boolean(state.signedIn), awaitingCredentials: Boolean(state.awaitingCredentials), loginWall: Boolean(state.loginWall || state.coverage?.loginForm || state.graph?.auth?.detected),
		plan: {
			summary: planSummary(plan),
			revisions: (plan.revisions ?? []).slice(-12).map(item => ({ revision: item.revision, trigger: item.trigger, added: item.added.length, ts: item.ts })),
			scenarios: (plan.scenarios ?? []).slice(0, 120).map(item => ({ id: item.id, unit: item.unit, title: item.title, state: item.state, reason: item.reason, priority: item.priority, origin: item.origin, revision: item.revision, findings: item.findings ?? 0, candidates: item.candidates ?? 0 }))
		},
		graph: state.graph ? { pages: Object.keys(state.graph.pages ?? {}).length, protected: Object.values(state.graph.pages ?? {}).filter(page => page.auth === 'protected').length, features: Object.fromEntries(Object.entries(state.graph.features ?? {}).filter(([, n]) => n > 0)), roles: state.graph.roles, auth: state.graph.auth ? { detected: state.graph.auth.detected, signedIn: state.graph.auth.signedIn, identifierStep: state.graph.auth.identifierStep, reauthentications: state.graph.auth.reauthentications ?? 0, blockedReason: state.graph.auth.blockedReason } : undefined } : undefined,
		capabilities: state.capabilitySummary, gate: state.gate ? { status: state.gate.status, failed: state.gate.failed } : undefined,
		routing: state.routing ? { decisions: state.routing.decisions?.length ?? 0, tokens: state.routing.tokens } : undefined
	};
}

/** Run state created at launch; allowWrites/auth are the owner's choices for this run. */
export function createQaState({ allowWrites = false, auth } = {}) {
	return { ...initialState(), allowWrites: allowWrites === true, auth: auth ? { authorized: auth.authorized === true, loginUrl: auth.loginUrl, expectedUrl: auth.expectedUrl } : undefined };
}

function initialState() {
	return {
		version: ENGINE_VERSION, architecture: ENGINE_ARCHITECTURE, engine: 'qase-qa-engine', status: 'running', startedAt: Date.now(), updatedAt: Date.now(),
		phase: 'observe', phases: {}, visited: [], candidates: [], limitations: [], findingDetails: {}, models: {},
		graph: undefined, plan: undefined, routing: undefined, authEvents: [],
		coverage: { pages: 0, viewports: [], viewportNames: [], interactions: 0, hoverMenus: 0, forms: 0, securityChecks: 0, injectionUrls: 0, linksChecked: 0, exploration: 0, visualReviews: 0, scenarios: 0 }
	};
}

/**
 * Runs (or resumes) one QA engine run to completion.
 * record: the live record (controller, running flags, bridge shim for frames).
 */
export async function runQaEngine({ session, runStore, record, signal, fetchImpl: probeFetch = fetch, modelFetch = fetch, env = process.env, settings = qaModelSettings(env), artifactStore = createArtifactStore() }) {
	if (session.report) {
		await runStore.addMessage(session, { role: 'assistant', text: 'This QA run is complete. Start a new run to test the site again.' });
		return;
	}
	if (!session.targetUrl) {
		await runStore.setStatus(session, 'awaiting_input', 'Waiting for a target URL.');
		return;
	}
	const options = engineOptions(env);
	session.qaExecutionMode = 'hybrid';
	if (session.hybrid?.version !== ENGINE_VERSION || session.hybrid?.architecture !== ENGINE_ARCHITECTURE) session.hybrid = { ...initialState(), allowWrites: session.hybrid?.allowWrites, auth: session.hybrid?.auth };
	const state = session.hybrid;
	session.qaAuth ??= state.auth;
	state.status = 'running';
	state.resumedAt = state.phases.observe ? Date.now() : undefined;
	state.coverage.viewportNames ??= [];
	state.authEvents ??= [];
	const started = Date.now();
	const elapsedBefore = state.elapsedMs ?? 0;
	const budgetMs = Math.max(120_000, options.budgetMs - elapsedBefore);
	let pausedMs = 0; // time spent waiting for the owner does not consume the budget
	const budgetEnd = () => started + budgetMs + pausedMs;
	const stageDeadline = id => {
		const remaining = Math.max(0, budgetEnd() - Date.now());
		const pending = STAGE_IDS.slice(STAGE_IDS.indexOf(id)).filter(key => key === id || !['done', 'skipped', 'failed'].includes(state.phases[key]?.status));
		const total = pending.reduce((sum, key) => sum + STAGE_SHARE[key], 0) || 1;
		return Date.now() + remaining * STAGE_SHARE[id] / total;
	};
	let artifacts = 0;

	const model = createAppGraph(state.graph);
	state.graph = model.graph;
	const plan = createPlan(state.plan);
	state.plan = plan;
	const recovered = recoverInterrupted(plan);

	// checkpoint=true marks a durable checkpoint (stage and scenario boundaries).
	const persist = async ({ checkpoint = false } = {}) => {
		state.updatedAt = Date.now();
		state.elapsedMs = elapsedBefore + (Date.now() - started) - pausedMs;
		state.routing = router?.state();
		try { await runStore.commit(session, 'hybrid.state', { hybrid: publicQaState(session), ...(checkpoint ? { checkpoint: true } : {}) }); }
		catch (error) { console.warn('[qa-engine] checkpoint failed:', error?.message); }
	};
	/** Posts an agent message to the conversation. `id` makes the message idempotent across a resume. */
	const say = async (text, { kind = 'qa-step', id } = {}) => {
		if (id && session.messages?.some(message => message.id === id)) return;
		try { await runStore.addMessage(session, { ...(id ? { id } : {}), role: 'agent', kind, text: redact(session.id, text) }); } catch { /* best effort */ }
	};
	let progressAt = 0;
	let currentActivity;
	/** Live one-line status under the conversation ("Checking /pricing on mobile…"). */
	const progress = async detail => {
		if (!currentActivity || Date.now() - progressAt < 1200) return;
		progressAt = Date.now();
		try { await runStore.updateActivity(session, currentActivity, { detail: String(detail).slice(0, 160) }); } catch { /* best effort */ }
	};
	const save = async (bytes, text) => {
		if (!bytes || artifacts >= options.maxArtifacts) return undefined;
		try {
			artifacts++;
			return artifactStore.save(session, { type: 'screenshot', fileName: 'evidence.jpg', bytes, label: String(text).slice(0, 200) }).artifactId;
		} catch { return undefined; }
	};
	const usage = [];
	const baseModels = createQaModels({ settings, state: state.models, fetchImpl: modelFetch, onUsage: entry => usage.push(entry), log: line => console.warn(`[qa-engine] ${line}`) });
	const router = createRouter({ models: baseModels, log: state.routing });
	const models = router.models;
	const flushUsage = async () => {
		if (!usage.length) return;
		const { applyUsage } = await import('../usageCapture.js');
		for (const entry of usage.splice(0)) session.tokenUsage = applyUsage(session.tokenUsage, entry);
		try { await runStore.commit(session, 'usage', { usage: session.tokenUsage, mode: session.mode }); } catch { /* usage display is best effort */ }
	};
	const todoStatus = status => ['done', 'skipped', 'failed', 'passed', 'not_applicable', 'unsupported'].includes(status) ? 'completed' : status === 'running' ? 'in_progress' : ['failed', 'blocked', 'inconclusive', 'not_executed'].includes(status) ? 'completed' : 'pending';
	// The plan view shows the stages and, once the plan exists, its scenarios as they run.
	const todos = () => [
		...STAGES.map(([id, text]) => ({ id, text, status: todoStatus(state.phases[id]?.status) })),
		...plan.scenarios.slice(0, 60).map(item => ({ id: `scenario:${item.id}`, text: item.title, status: todoStatus(item.state), parent: 'execute', state: item.state }))
	];
	const syncTodos = async () => {
		session.todos = todos();
		try { await runStore.commit(session, 'todos', { todos: session.todos }); } catch { /* plan view is best effort */ }
	};
	const limitation = (stage, message, affectsCoverage = false) => {
		if (!state.limitations.some(item => item.message === message)) state.limitations.push({ phase: stage, message: String(message).slice(0, 500), affectsCoverage });
	};
	let currentScenario;
	const addCandidates = items => {
		for (const item of items ?? []) if (state.candidates.length < 1500) state.candidates.push(redact(session.id, currentScenario ? { ...item, scenarioId: currentScenario } : item));
	};

	let browser;
	let fetchImpl = probeFetch;
	const blocked = { writes: 0, offsite: 0, samples: [] };
	const stopped = () => signal?.aborted;

	async function stage(id, work, narrate) {
		if (['done', 'skipped'].includes(state.phases[id]?.status)) return;
		if (stopped()) { state.phases[id] = { status: 'skipped', detail: 'Stopped by user' }; return; }
		state.phase = id;
		const startedAt = Date.now();
		state.phases[id] = { status: 'running', startedAt };
		await syncTodos();
		await persist();
		const activityId = randomUUID();
		currentActivity = activityId;
		const before = state.candidates.length;
		try { await runStore.addActivity(session, { id: activityId, type: 'tool', toolName: `qa_${id}`, status: 'running', label: label(id) }); } catch { /* feed is best effort */ }
		try {
			if (Date.now() >= stageDeadline(id) && !['triage', 'publish', 'plan'].includes(id)) {
				state.phases[id] = { status: 'skipped', detail: 'Run time budget reached' };
				limitation(id, `${label(id)} was skipped because the run time budget was reached.`, true);
			} else {
				const detail = await work(stageDeadline(id));
				state.phases[id] = { status: /^skipped/i.test(detail ?? '') ? 'skipped' : 'done', detail: detail ?? undefined, startedAt, endedAt: Date.now() };
			}
		} catch (error) {
			if (stopped()) state.phases[id] = { status: 'skipped', detail: 'Stopped by user' };
			else {
				const message = String(error?.message ?? error).split('\n')[0].slice(0, 300);
				if (!error?.expected) console.warn(`[qa-engine] stage ${id} failed:`, error);
				state.phases[id] = { status: 'failed', detail: message, startedAt, endedAt: Date.now() };
				limitation(id, `${label(id)} did not complete: ${message}`, ['observe', 'discover'].includes(id));
				if (error?.expected || error?.policyBlocked) throw error;
			}
		}
		currentActivity = undefined;
		try { await runStore.updateActivity(session, activityId, { status: state.phases[id].status === 'failed' ? 'error' : 'done', summary: state.phases[id].detail ?? state.phases[id].status, detail: '' }); } catch { /* best effort */ }
		const added = state.candidates.slice(before);
		if (state.phases[id].status === 'done' && narrate) {
			const text = narrate(added, state.phases[id].detail);
			if (text) await say(text, { id: `qa-step-${id}-${state.startedAt}` });
		} else if (state.phases[id].status === 'failed') {
			await say(`I couldn't finish this step (${label(id).toLowerCase()}): ${state.phases[id].detail}. I'm carrying on; the report will list what was missed.`, { id: `qa-step-${id}-failed-${state.startedAt}` });
		}
		await flushUsage();
		await syncTodos();
		await persist({ checkpoint: true });
	}

	const primary = primaryProfile(session);
	const secondary = primary.isMobile ? [VIEWPORTS.desktop] : [VIEWPORTS.mobile, VIEWPORTS.tablet];
	const pages = new Map(state.pages ? Object.entries(state.pages) : []);
	const shots = [];
	let filmstrips = [];
	const links = new Map(Object.entries(state.links ?? {}));
	let mainResponse;
	let cookies = [];
	let loaded = Boolean(state.loaded);
	const host = (() => { try { return new URL(session.targetUrl).host; } catch { return session.targetUrl; } })();
	const origin = (() => { try { return new URL(session.targetUrl).origin; } catch { return ''; } })();
	const pageList = () => [...pages.keys()];
	const noteViewport = profile => {
		if (!state.coverage.viewports.includes(profile.label)) state.coverage.viewports.push(profile.label);
		if (!state.coverage.viewportNames.includes(profile.name)) state.coverage.viewportNames.push(profile.name);
	};
	const isLoginUrl = url => { try { const parsed = new URL(url); return LOGIN_PATH.test(parsed.pathname) || (state.loginUrl && parsed.pathname === new URL(state.loginUrl).pathname); } catch { return false; } };

	/**
	 * Pauses the run and asks the owner for a test account through the secure
	 * card in the conversation (at most once, plus once after a rejection).
	 */
	async function askForAccount({ retry = false, reason } = {}) {
		state.awaitingCredentials = true;
		const { answer, waitedMs } = await waitForAccount({ session, runStore, record, signal, waitMs: options.credentialWaitMs, question: accountQuestion({ host, retry, reason }) });
		pausedMs += waitedMs;
		state.awaitingCredentials = false;
		if (answer.skip || answer.timeout) state.credentialsDeclined = true;
		if (answer.timeout) await say(`I didn't get an answer within ${Math.round(options.credentialWaitMs / 60000)} minutes, so I'm continuing with the public pages. Start a new run with a test account to cover the signed-in area.`);
		else if (answer.skip) await say('OK, I\'ll test the public pages only.');
		return answer;
	}

	/** Signs in with the vault credentials and verifies the session. */
	async function signInOnce() {
		const authRoutes = await discoverAuthRoutes(origin, { fetchImpl }).catch(() => []);
		const auth = model.graph.auth;
		const outcome = await signIn({ browser, profile: primary, session, candidates: [state.loginUrl, ...(auth.loginLinks ?? []), session.targetUrl, ...pageList().filter(url => pages.get(url)?.login), ...authRoutes.filter(url => !/logout|redirect|out$/.test(url))].filter(Boolean) });
		if (outcome.ok) {
			// Verification: a page reached through the session must not bounce back to sign-in.
			const { page } = await openPage(outcome.url, { noReauth: true });
			let bounced = await isSignInPage(page);
			// Single-page apps often show their sign-in screen for a moment while they restore
			// the session from storage; give them time before concluding the session was lost.
			for (let wait = 0; bounced && wait < 3; wait++) {
				await page.waitForTimeout(2000);
				await browser.settle(page, { quietMs: 800 }).catch(() => {});
				bounced = await isSignInPage(page);
			}
			const after = await detectAuth(page);
			await page.close().catch(() => {});
			if (bounced) {
				await browser.useSignedInState(undefined);
				const kept = outcome.verified?.storage;
				return { ok: false, retry: false, reason: `The sign-in form disappeared, but a new tab opened on ${pathOf(outcome.url)} showed the sign-in form again, even with the session's cookies (${kept?.cookies ?? 0}), local storage, IndexedDB and session storage (${kept?.sessionStorageKeys ?? 0} keys) carried over. The app may tie its session to a single tab or device check.` };
			}
			outcome.verifiedBy = [outcome.verified?.logoutControl || after.logout ? 'sign-out control visible' : '', !isLoginUrl(outcome.url) ? `landed on ${pathOf(outcome.url)}` : '', 'reload kept the session'].filter(Boolean).join(', ');
		}
		state.signedIn = outcome.ok;
		if (outcome.ok) state.signedInUrl = outcome.url;
		state.authEvents.push({ ts: Date.now(), kind: 'signin', ok: outcome.ok, steps: outcome.steps, reason: outcome.ok ? undefined : outcome.reason });
		return outcome;
	}

	/** Session expired mid-run: sign in again (bounded), never asking the owner again. */
	async function reauthenticate(url) {
		const auth = model.graph.auth;
		state.authEvents.push({ ts: Date.now(), kind: 'expired', url: pathOf(url) });
		if ((auth.reauthentications ?? 0) >= options.maxReauth) {
			limitation('signin', `The session expired again after ${options.maxReauth} re-authentications; later signed-in checks may have seen the sign-in page.`, true);
			return false;
		}
		const outcome = await signInOnce();
		model.setAuth({ reauthentications: (auth.reauthentications ?? 0) + 1, signedIn: outcome.ok, lastReauthOk: outcome.ok });
		state.authEvents.push({ ts: Date.now(), kind: 'reauth', ok: outcome.ok });
		if (outcome.ok) await say(`The session expired while I was on \`${pathOf(url)}\`; I signed in again and carried on.`, { id: `qa-reauth-${model.graph.auth.reauthentications}-${state.startedAt}` });
		return outcome.ok;
	}

	/** Opens a page, re-authenticating once when a signed-in page bounces to sign-in. */
	async function openPage(url, { profile = primary, anonymous, colorScheme, reducedMotion, isolated, noReauth, quietMs } = {}) {
		let { page, log } = await browser.openPage(profile, { anonymous, colorScheme, reducedMotion, isolated });
		if (url && url !== 'about:blank') await browser.goto(page, url, log, quietMs ? { quietMs } : undefined);
		if (state.signedIn && !anonymous && !noReauth && url && url !== 'about:blank' && !isLoginUrl(url) && await isSignInPage(page)) {
			await page.close().catch(() => {});
			const again = await reauthenticate(url);
			({ page, log } = await browser.openPage(profile, { anonymous, colorScheme, reducedMotion, isolated }));
			await browser.goto(page, url, log, quietMs ? { quietMs } : undefined);
			if (!again) log.sessionLost = true;
		}
		// Tours, welcome modals and consent banners block every click: clear them first.
		if (url && url !== 'about:blank' && !page.isClosed()) {
			const cleared = await dismissOverlays(page, { cursor: (target, text) => browser.pointAt(page, target, text) }).catch(() => []);
			for (const item of cleared) if (!(state.overlaysDismissed ??= []).includes(item) && state.overlaysDismissed.length < 20) {
				state.overlaysDismissed.push(item);
				void say(`A pop-up was covering the app (${item}); I closed it so testing can continue.`, { id: `qa-overlay-${state.overlaysDismissed.length}-${state.startedAt}` });
			}
		}
		return { page, log };
	}

	/** The sign-in step: the account from launch, or asked for once when sign-in was detected. */
	async function accountStep() {
		const needsAsk = !session.qaAuth?.authorized && !state.credentialsDeclined && options.askForCredentials && !session.matrixRunId;
		if (!session.qaAuth?.authorized && !needsAsk) {
			model.setAuth({ blockedReason: state.credentialsDeclined ? 'No test account was given.' : 'No test account was provided for this run (asking is disabled).' });
			if (state.phases.signin?.status !== 'done') state.phases.signin = { status: 'skipped', detail: 'No test account' };
			return false;
		}
		let signedIn = false;
		state.phases.signin = undefined;
		await stage('signin', async () => {
			if (!session.qaAuth?.authorized) {
				const answer = await askForAccount();
				if (!answer.credentials) {
					model.setAuth({ blockedReason: answer.stopped ? 'Stopped before a test account was given.' : 'The owner chose to test public pages only.' });
					return answer.stopped ? 'skipped (stopped by user)' : 'skipped (public pages only)';
				}
				await say('Thanks, I have the test account. Signing in…');
			}
			for (let attempt = 0; attempt < 2; attempt++) {
				const outcome = await signInOnce();
				if (outcome.ok) {
					signedIn = true;
					model.setAuth({ signedIn: true, verifiedBy: outcome.verifiedBy, steps: outcome.steps, identifierStep: model.graph.auth.identifierStep || Boolean(outcome.steps?.includes('identifier')), blockedReason: undefined });
					await say(`Signed in${outcome.steps?.includes('identifier') ? ' (two steps: username, then password)' : ''} and verified the session (${outcome.verifiedBy}). I'm testing the signed-in area too, read-only, starting at \`${pathOf(outcome.url)}\`.`);
					return 'signed in';
				}
				if (outcome.human) {
					model.setAuth({ challenge: outcome.human, blockedReason: `The site requires ${outcome.human === 'captcha' ? 'a CAPTCHA' : 'a verification code'} — a person must complete it.` });
					limitation('signin', `Signed-in areas were not tested: ${outcome.reason} QASE does not bypass security controls.`, true);
					await say(`The sign-in needs a person: ${outcome.reason} I won't try to get around it. I'll test the public pages; start a run with an account that does not require this (or complete it and resume) to cover the signed-in area.`);
					return 'public only';
				}
				if (attempt === 1 || outcome.retry === false || !options.askForCredentials || session.matrixRunId) {
					model.setAuth({ blockedReason: outcome.reason });
					limitation('signin', `Signed-in areas were not tested. ${outcome.reason} Public pages were tested instead.`, true);
					await say(`I couldn't sign in. ${outcome.reason} I'll continue with the public pages; the report lists this as blocked.`);
					return 'public only';
				}
				await say(`That didn't work. ${outcome.reason}`);
				const retry = await askForAccount({ retry: true, reason: outcome.reason.replace(/\.$/, '') });
				if (!retry.credentials) {
					model.setAuth({ blockedReason: outcome.reason });
					limitation('signin', `Signed-in areas were not tested. ${outcome.reason}`, true);
					return 'public only';
				}
				await say('Trying the new test account…');
			}
			return 'public only';
		});
		return signedIn;
	}

	/** Audits one page into the graph. Returns 'ok' | 'skip' | 'error'. */
	async function auditInto(url, { discoveredBy, depth = 0, from, frontier, anonymous = false } = {}) {
		let page, log;
		try {
			({ page, log } = await openPage(url, { anonymous }));
		} catch (error) {
			addCandidates([candidate({ detector: 'page.unreachable', category: 'functional', severity: 'high', confidence: 0.7, title: `Page fails to load: ${pathOf(url)}`, url, viewport: primary.name, actual: String(error.message).split('\n')[0], expected: 'The page loads.', steps: [`Open ${url}`], data: { key: url } })]);
			return 'error';
		}
		try {
			const finalUrl = normalizeUrl(page.url(), url) ?? url;
			if (from) model.addTransition(from, finalUrl, 'link');
			// A signed-in page that bounced to sign-in in the anonymous pass is protected.
			if (anonymous && finalUrl !== url && isLoginUrl(finalUrl)) { model.addPage(url, { status: 302, auth: 'protected', discoveredBy, depth, audited: true, protection: 'redirects to sign-in', features: { protected: 1 } }); return 'skip'; }
			if (finalUrl !== url && (state.visited.includes(finalUrl) || pages.has(finalUrl))) return 'skip';
			// A redirect to a fresh id of a screen we already have (e.g. a new chat per visit) adds nothing.
			if (finalUrl !== url && model.hasTemplate(finalUrl) && !model.page(finalUrl)) { if (!model.page(url)) model.addTransition(url, finalUrl, 'redirect'); return 'skip'; }
			const status = log.mainResponse?.status ?? 200;
			if (status >= 400) {
				if (status >= 500) addCandidates([candidate({ detector: 'page.http_error_page', category: 'functional', severity: 'critical', confidence: 0.95, title: `Page returns HTTP ${status}`, url: finalUrl, viewport: primary.name,
					actual: `${finalUrl} responded with HTTP ${status}.`, expected: 'The page loads successfully.', steps: [`Open ${finalUrl}`], fix: 'Fix the server error for this route and serve a helpful error page.', data: { key: String(status) } })]);
				const features = await observeFeatures(page);
				model.addPage(finalUrl, { status, title: features.title, heading: features.heading, discoveredBy, depth, audited: true, features: { restricted: [401, 403].includes(status) ? 1 : features.restricted } });
				return 'skip';
			}
			const result = await auditPage(page, { url: finalUrl, viewport: primary.name, touch: primary.hasTouch, log, save });
			addCandidates(result.candidates);
			addCandidates(await auditPageSecurity(page, { url: finalUrl, viewport: primary.name, fetchImpl }).catch(() => []));
			state.coverage.securityChecks += 7;
			const login = await hasLoginForm(page) || (await detectAuth(page)).identifierStep;
			if (login) { state.coverage.loginForm = true; state.loginUrl ??= finalUrl; model.setAuth({ detected: true }); }
			const features = await observeFeatures(page);
			const added = model.addPage(finalUrl, { status, title: features.title, heading: features.heading, features, login, discoveredBy, depth, audited: true, auth: model.page(finalUrl)?.auth === 'protected' ? 'protected' : discoveredBy === 'signed-in' ? 'signed-in' : 'public' });
			if (log.websockets?.length) model.websocket(finalUrl);
			if (added.length) state.discoveries = [...(state.discoveries ?? []), ...added.map(feature => `${feature} on ${pathOf(finalUrl)}`)].slice(-40);
			await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
			await browser.hideCursor(page);
			const shot = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => undefined);
			if (shot && shots.length < options.visualShots) shots.push({ url: finalUrl, viewport: primary.label, bytes: shot });
			for (const link of result.metrics?.links ?? []) {
				const normalized = normalizeUrl(link.href, finalUrl);
				if (!normalized) continue;
				if (!links.has(normalized)) links.set(normalized, { text: link.text, pages: [] });
				const entry = links.get(normalized);
				if (entry.pages.length < 10 && !entry.pages.includes(finalUrl)) entry.pages.push(finalUrl);
				if (frontier?.add(normalized, finalUrl)) depthOf.set(normalized, depth + 1);
			}
			pages.set(finalUrl, { title: result.metrics?.title, forms: result.metrics?.forms ?? 0, controls: result.metrics?.controls ?? 0, params: [...new URL(finalUrl).searchParams.keys()], login, signedIn: discoveredBy === 'signed-in' });
			if (finalUrl !== url) state.visited.push(finalUrl);
			state.coverage.pages = pages.size;
			state.pages = Object.fromEntries(pages);
			state.links = Object.fromEntries([...links].slice(0, 400));
			return 'ok';
		} finally {
			await page.close().catch(() => {});
		}
	}
	const depthOf = new Map();

	/** Bounded crawl into the graph. */
	async function crawlPass(deadline, starts, { maxPages = options.maxPages, discoveredBy = 'crawl', anonymous = false } = {}) {
		const frontier = createFrontier({ start: starts[0], inScope: browser.inScope, maxPages });
		for (const url of starts.slice(1)) frontier.add(url);
		frontier.restore(state.visited);
		let url;
		let audited = 0;
		while ((url = frontier.next()) && pages.size < maxPages && Date.now() < deadline && !stopped()) {
			if (state.visited.includes(url) && pages.has(url)) continue;
			// /items/123 and /items/456 are one screen: audit a route template once.
			if (!starts.includes(url) && model.hasTemplate(url) && !model.page(url)) { state.visited.push(url); continue; }
			await progress(`Mapping ${pathOf(url)}`);
			const outcome = await auditInto(url, { discoveredBy, depth: depthOf.get(url) ?? 0, frontier, anonymous });
			state.visited.push(url);
			if (outcome === 'ok') audited++;
			await persist();
		}
		noteViewport(primary);
		if (frontier.size > pages.size && pages.size >= maxPages) limitation('discover', `Mapped the first ${pages.size} pages (limit QASE_QA_MAX_PAGES=${options.maxPages}); ${frontier.size - pages.size} more discovered pages were not audited.`, true);
		return audited;
	}

	/** Re-derive the plan from the graph; records a revision when anything new is planned. */
	const replan = async trigger => {
		if (plan.scenarios.length >= options.maxScenarios) return undefined;
		const derived = scenariosFromGraph({ graph: model, start: session.targetUrl, signedInUrl: state.signedInUrl, signedIn: Boolean(state.signedIn), options }).slice(0, options.maxScenarios - plan.scenarios.length);
		const revision = revisePlan(plan, derived, { trigger });
		if (revision) router.record({ task: 'planning', model: 'deterministic', reason: `Plan revision ${revision.revision}: ${trigger}`, outcome: `+${revision.added.length} scenario(s)` });
		return revision;
	};

	// ---- Scenario units -------------------------------------------------------------------
	let exploreSummaries = [];
	const executorContext = deadline => ({
		browser, profile: primary, open: (url, opts) => openPage(url, opts), fetchImpl, deadline, save, model, signedIn: Boolean(state.signedIn),
		isSignInPage, isLoginUrl, origin, start: session.targetUrl, signedInUrl: state.signedInUrl,
		reauthenticate: url => reauthenticate(url)
	});
	const units = {
		async page_audit(scenario) {
			let tested = 0;
			for (const url of scenario.targets) {
				const page = model.page(url);
				const outcome = await auditInto(url, { discoveredBy: page?.discoveredBy ?? 'explore', depth: page?.depth ?? 1 });
				if (outcome !== 'error') tested++;
				if (model.page(url)) model.page(url).audited = true;
			}
			return { tested, evidence: [`Audited ${scenario.targets.map(pathOf).join(', ')} (layout, content, accessibility, console, network, client-side security).`] };
		},
		async viewports(scenario, deadline) {
			let tested = 0;
			for (const profile of secondary) {
				for (const url of scenario.targets) {
					if (Date.now() >= deadline || stopped()) break;
					await progress(`Checking ${pathOf(url)} on ${profile.label}`);
					const { page, log } = await openPage(url, { profile });
					try {
						addCandidates((await auditPage(page, { url, viewport: profile.name, touch: profile.hasTouch, log, save })).candidates);
						tested++;
						await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
			await browser.hideCursor(page);
						const shot = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => undefined);
						if (shot && shots.length < options.visualShots + 4 && profile.isMobile) shots.push({ url, viewport: profile.label, bytes: shot });
					} catch { /* one page failing is recorded by its own candidates */ }
					finally { await page.close().catch(() => {}); }
				}
				noteViewport(profile);
			}
			return { tested, evidence: [`${scenario.targets.length} key page(s) audited on ${secondary.map(profile => profile.label).join(' and ')}.`] };
		},
		async interactions(scenario, deadline) {
			let tested = 0;
			const evidence = [];
			const profiles = [primary, ...secondary.filter(profile => profile.isMobile).slice(0, 1)];
			for (const profile of profiles) {
				for (const url of scenario.targets) {
					if (Date.now() >= deadline || stopped()) break;
					await progress(`Clicking menus and toggles on ${pathOf(url)} (${profile.label})`);
					const { page, log } = await openPage(url, { profile });
					browser.setActivePage(page);
					try {
						const reload = async () => { await browser.goto(page, url, log, { quietMs: 800 }).catch(() => {}); };
						const result = await testInteractions(page, { url, viewport: profile.name, browser, reload, save, limit: options.triggersPerPage, deadline });
						addCandidates(result.candidates);
						state.coverage.interactions += result.tested;
						tested += result.tested;
						filmstrips.push(...result.filmstrips);
						evidence.push(`${pathOf(url)} (${profile.label}): ${result.tested} control(s) clicked, ${result.filmstrips.length} filmstrip(s).`);
					} finally { await page.close().catch(() => {}); }
				}
			}
			filmstrips = filmstrips.slice(0, 8);
			return { tested, evidence, notApplicable: tested ? undefined : 'No clickable menus, toggles or dialogs were found on this page.' };
		},
		async hover(scenario) {
			const url = scenario.targets[0];
			const { page } = await openPage(url);
			try { addCandidates(await testHoverMenus(page, { url, viewport: primary.name, save })); state.coverage.hoverMenus += 1; }
			finally { await page.close().catch(() => {}); }
			return { tested: 1, evidence: [`Hovered the navigation on ${pathOf(url)}.`] };
		},
		async reduced_motion(scenario) {
			const url = scenario.targets[0];
			const { page } = await openPage(url, { reducedMotion: 'reduce' });
			try { await page.waitForTimeout(600); addCandidates(await testReducedMotion(page, { url, viewport: primary.name })); }
			finally { await page.close().catch(() => {}); }
			return { tested: 1, evidence: [`Loaded ${pathOf(url)} with prefers-reduced-motion: reduce and measured running animations.`] };
		},
		async forms(scenario) {
			let tested = 0;
			for (const url of scenario.targets) {
				await progress(`Testing the form on ${pathOf(url)}`);
				const { page, log } = await openPage(url);
				browser.setActivePage(page);
				try {
					const result = await testForms(page, { url, viewport: primary.name, browser, blocked: () => blocked.writes, reload: () => browser.goto(page, url, log, { quietMs: 800 }).catch(() => {}), save });
					addCandidates(result.candidates);
					state.coverage.forms += result.tested;
					tested += result.tested;
					if (result.inventory.some(form => form.role === 'login')) state.coverage.loginForm = true;
					// Upload inputs: inspected, never used.
					const uploads = await page.evaluate(() => [...document.querySelectorAll('input[type=file]')].map(input => ({ name: input.name || input.id || 'file', accept: input.accept, label: Boolean(input.labels?.length || input.getAttribute('aria-label')) }))).catch(() => []);
					for (const upload of uploads.filter(item => !item.accept)) addCandidates([candidate({ detector: 'forms.upload_no_type_limit', category: 'forms', severity: 'low', confidence: 0.55, url, viewport: primary.name, title: `File input "${upload.name}" accepts any file type`, actual: 'The file input has no accept attribute, so users get no guidance and any file can be chosen.', expected: 'Upload inputs declare the accepted types (and the server enforces them).', steps: [`Open ${url}`, `Inspect the "${upload.name}" file input`], data: { key: `${url}|${upload.name}`, harness: 'QASE did not upload a file; server-side type checks were not tested.' } })]);
				} finally { await page.close().catch(() => {}); }
			}
			return { tested, evidence: [`${tested} form(s) on ${scenario.targets.map(pathOf).join(', ')} tested with empty and malformed input (nothing submitted).`], notApplicable: tested ? undefined : 'No testable form fields.' };
		},
		async security_origin(scenario, deadline) {
			await progress('Checking headers, cookies and exposed files');
			addCandidates(await auditOrigin({ targetUrl: session.targetUrl, mainResponse, cookies, fetchImpl, deadline }));
			state.coverage.securityChecks += 24;
			return { tested: 24, evidence: ['Headers, cookies, CORS, transport, 13 exposed-file probes and security.txt checked.'] };
		},
		async injection(scenario, deadline) {
			let tested = 0;
			for (const url of scenario.targets) {
				if (Date.now() >= deadline || stopped()) break;
				await progress(`Probing ${pathOf(url)} for injection`);
				addCandidates(await probeInjection({ browser, profile: primary, url, params: pages.get(url)?.params ?? [], fetchImpl, deadline }));
				state.coverage.injectionUrls++;
				state.coverage.securityChecks += 4;
				tested++;
			}
			return { tested, evidence: [`Reflected/DOM XSS and SQL-error probes on ${scenario.targets.map(pathOf).join(', ')}.`] };
		},
		async redirects(scenario, deadline) {
			const authRoutes = await discoverAuthRoutes(origin, { fetchImpl }).catch(() => []);
			const targets = [...new Set([session.targetUrl, ...pageList().filter(url => /login|signin|sign-in|auth|logout|redirect|account/i.test(url)), ...authRoutes])].slice(0, 5);
			addCandidates(await probeRedirects({ urls: targets, fetchImpl, deadline }));
			state.coverage.securityChecks += targets.length;
			return { tested: targets.length, evidence: [`Open-redirect probes on ${targets.map(pathOf).join(', ')}.`] };
		},
		async links(scenario, deadline) {
			await progress(`Checking ${plural(links.size, 'link')}`);
			const result = await checkLinks({ links, origin, fetchImpl, deadline });
			addCandidates(result.candidates);
			state.coverage.linksChecked = result.checked;
			return { tested: result.checked, evidence: [`${result.checked} distinct links requested.`] };
		},
		async explore(scenario, deadline) {
			const choice = router.decide('exploration');
			if (choice.model !== 'reasoner') {
				limitation('execute', baseModels.state.reasoner.enabled ? `AI journey "${scenario.goal}" was not run (reasoning model error: ${baseModels.state.reasoner.lastError ?? 'unknown'}).` : 'AI journeys were skipped: no reasoning model is configured.');
				return { tested: 0, inconclusive: 'The reasoning model was unavailable for this journey.' };
			}
			const startUrl = scenario.start ? new URL(scenario.start, state.signedInUrl ?? session.targetUrl).href : state.signedInUrl ?? session.targetUrl;
			const result = await explore({ browser, profile: primary, startUrl: browser.inScope(startUrl) ? startUrl : session.targetUrl, models, knownIssues: state.candidates.map(item => item.title).slice(0, 40), maxSteps: options.exploreSteps, deadline, signal,
				blockedWrites: () => blocked.writes, save, signedIn: Boolean(state.signedIn), pages: pageList().map(pathOf), goal: scenario.goal,
				focus: session.testCaseSnapshot?.title ?? session.messages?.find(message => message.role === 'user')?.text?.slice(0, 500),
				onStep: step => { state.coverage.exploration = (state.coverage.exploration ?? 0) + 1; void progress(`AI tester: ${step.name}${step.args?.url ? ` ${pathOf(step.args.url)}` : ''} on ${pathOf(step.url)}`); } });
			addCandidates(result.candidates);
			// Pages the journey reached that the crawl never saw join the graph (and get audited).
			for (const url of result.summary.visited ?? []) {
				const normalized = normalizeUrl(url, session.targetUrl);
				if (normalized && browser.inScope(normalized) && !model.page(normalized) && !model.hasTemplate(normalized) && !isLoginUrl(normalized)) model.addPage(normalized, { discoveredBy: 'explore', audited: false, depth: 1, auth: state.signedIn ? 'signed-in' : 'public' });
			}
			exploreSummaries.push(result.summary.summary);
			// The step-by-step trail is kept so a run can be reviewed (and the agent improved) afterwards.
			scenario.trail = (result.summary.trail ?? []).slice(-60).map(step => redact(session.id, step));
			state.coverage.explorationSummary = exploreSummaries.filter(Boolean).join(' ').slice(0, 1500);
			const evidence = [`${result.summary.steps} step(s); ${result.summary.finished ? 'the model finished the journey' : 'stopped by its step/time limit'}${result.summary.loopWarnings ? `; ${result.summary.loopWarnings} loop warning(s)${result.summary.loopStopped ? ', ended for looping' : ''}` : ''}.`];
			if (result.summary.summary) evidence.push(`Model summary (not used as completion evidence): ${result.summary.summary.slice(0, 300)}`);
			if (!result.summary.steps) return { tested: 0, evidence, inconclusive: `The reasoning model did not respond (${baseModels.state.reasoner.lastError ?? 'no response'}).` };
			return { tested: result.summary.steps, evidence };
		},
		async visual(scenario, deadline) {
			const choice = router.decide('vision');
			if (choice.model !== 'reasoner' || !baseModels.visionAvailable()) {
				if (baseModels.state.reasoner.enabled) limitation('execute', `AI visual review was unavailable (reasoning model error: ${baseModels.state.reasoner.lastError ?? 'budget reached'}).`);
				return { tested: 0, inconclusive: baseModels.state.reasoner.enabled ? 'The reasoning model was unavailable for visual review.' : 'No reasoning model is configured, so screenshots were not reviewed.' };
			}
			await progress(`Reviewing ${plural(shots.length, 'screenshot')} and ${plural(filmstrips.length, 'animation filmstrip')}`);
			const result = await reviewVisuals({ models, shots, filmstrips, save, signal, deadline, maxCalls: options.visualShots + 4, known: state.candidates.map(item => item.title) });
			addCandidates(result.candidates);
			state.coverage.visualReviews = result.calls;
			return { tested: result.calls, evidence: [`${result.calls} screenshot/filmstrip review(s) (${shots.length} screenshots, ${filmstrips.length} filmstrips).`], inconclusive: result.calls ? undefined : 'No review call succeeded.' };
		}
	};
	for (const [unit, executor] of Object.entries(EXECUTORS)) {
		units[unit] ??= async (scenario, deadline) => {
			const result = await executor(executorContext(deadline), scenario, { auditPage });
			addCandidates(result.candidates);
			return result;
		};
	}

	/** Runs one scenario and records its outcome. */
	async function runScenario(scenario, deadline) {
		scenario.state = 'running';
		scenario.startedAt = Date.now();
		currentScenario = scenario.id;
		const before = state.candidates.length;
		await syncTodos();
		await persist({ checkpoint: true });
		try {
			const unit = units[scenario.unit];
			if (!unit) { scenario.state = 'unsupported'; scenario.reason = `No executor for "${scenario.unit}".`; return; }
			const result = await unit(scenario, deadline) ?? {};
			scenario.tested = result.tested ?? 0;
			scenario.evidence = (result.evidence ?? []).slice(0, 12).map(text => redact(session.id, String(text).slice(0, 400)));
			const added = state.candidates.length - before;
			scenario.candidates = added;
			if (stopped()) { scenario.state = added || scenario.tested ? (added ? 'failed' : 'passed') : 'not_executed'; scenario.reason = scenario.state === 'not_executed' ? 'Stopped by the owner.' : undefined; }
			else if (result.notApplicable && !added) { scenario.state = 'not_applicable'; scenario.reason = result.notApplicable; }
			else if (result.inconclusive && !added) { scenario.state = 'inconclusive'; scenario.reason = result.inconclusive; }
			else if (!scenario.tested && !added) { scenario.state = Date.now() >= deadline ? 'not_executed' : 'inconclusive'; scenario.reason = Date.now() >= deadline ? 'Its time slice ended before anything was tested.' : 'The executor ran but had nothing it could test.'; }
			else { scenario.state = added ? 'failed' : 'passed'; scenario.reason = added ? `${plural(added, 'possible issue')} pending verification.` : undefined; }
		} catch (error) {
			if (stopped()) { scenario.state = 'not_executed'; scenario.reason = 'Stopped by the owner.'; }
			else {
				scenario.state = 'inconclusive';
				scenario.reason = `The executor failed: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}`;
				console.warn(`[qa-engine] scenario ${scenario.id} failed:`, error?.message);
			}
		} finally {
			currentScenario = undefined;
			scenario.endedAt = Date.now();
			state.coverage.scenarios = plan.scenarios.filter(item => !['pending', 'running'].includes(item.state)).length;
		}
	}

	try {
		await runStore.setStatus(session, 'running', 'Testing the site');
		browser = await createQaBrowser({
			session, allowWrites: state.allowWrites === true, env,
			publishFrame: frame => { try { runStore.publish?.(session, 'frame', { frame }); } catch { /* live view is best effort */ } },
			onBlocked: event => {
				if (event.kind === 'write_blocked') blocked.writes++;
				else blocked.offsite++;
				if (blocked.samples.length < 20) blocked.samples.push(event);
			}
		});
		if (record) record.bridge = { getLastFrame: () => browser?.getLastFrame(), stopFrames: () => browser?.stopFrames() };
		fetchImpl = browser.guardedFetch(fetchImpl);
		if (!await browser.policyAllows(session.targetUrl, true)) throw Object.assign(new Error('The target is blocked by the browser safety policy (private or reserved network address). Allow it with QASE_BROWSER_ALLOWED_PRIVATE_HOSTS for an authorized internal target.'), { policyBlocked: true });
		browser.startFrames();
		session.runtimeFacts = { ...(session.runtimeFacts ?? {}), launchedEngineId: browser.engine, browserVersion: browser.version, executionLevel: session.runtimeFacts?.executionLevel ?? 'SIMULATED', capturedAt: Date.now() };
		state.coverage.engine = `${browser.engine} ${browser.version}`;
		const browserName = browser.engine === 'chromium' ? `Chrome ${String(browser.version).split('.')[0]}` : `${browser.engine} ${browser.version}`;
		await say(`I'm opening **${host}** in ${browserName} on ${primary.label} to see what the app is before I plan anything.`, { id: `qa-hello-${state.startedAt}` });
		if (recovered.length) await say(`Resumed after an interruption: ${recovered.map(item => `${item.id} → ${item.state === 'pending' ? 're-queued (read-only)' : 'inconclusive (not replayed)'}`).join('; ')}.`, { id: `qa-recovered-${Date.now()}` });

		// Stage A. Observe — before any plan exists.
		await stage('observe', async () => {
			let attempt = 0;
			let lastError;
			while (attempt++ < 3 && !stopped()) {
				try {
					const { page, log } = await openPage(session.targetUrl, { noReauth: true });
					mainResponse = log.mainResponse;
					cookies = await page.context().cookies();
					const finalUrl = normalizeUrl(page.url(), session.targetUrl) ?? session.targetUrl;
					const features = await observeFeatures(page);
					const auth = await detectAuth(page);
					const passwordWall = await hasLoginForm(page);
					const aria = await page.locator('body').ariaSnapshot({ timeout: 5000 }).catch(() => '');
					const shot = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => undefined);
					const artifactId = await save(shot, `First look at ${pathOf(finalUrl)}`);
					state.loadMs = await page.evaluate(() => Math.round(performance.getEntriesByType('navigation')[0]?.loadEventEnd || 0)).catch(() => 0);
					state.loginWall = passwordWall || auth.identifierStep;
					if (state.loginWall) state.loginUrl = finalUrl;
					else if (auth.loginLinks.length) state.loginUrl = auth.loginLinks[0];
					model.setAuth({ detected: Boolean(state.loginWall || auth.loginLinks.length || auth.sso.length || session.qaAuth?.authorized), passwordForm: passwordWall, identifierStep: auth.identifierStep, loginLinks: auth.loginLinks, sso: auth.sso, challenge: auth.challenge, loginUrl: state.loginUrl });
					model.addPage(finalUrl, { status: mainResponse?.status, title: features.title, heading: features.heading, features, login: state.loginWall, discoveredBy: 'observe', depth: 0, audited: false, auth: 'public' });
					state.observation = {
						at: Date.now(), url: finalUrl, status: mainResponse?.status, title: features.title, heading: features.heading,
						features: Object.fromEntries(Object.entries(features).filter(([key, value]) => typeof value === 'number' && value > 0 && !['links', 'controls', 'headings'].includes(key))),
						links: features.links, controls: features.controls, auth: { passwordForm: passwordWall, identifierStep: auth.identifierStep, loginLinks: auth.loginLinks.map(pathOf), sso: auth.sso, challenge: auth.challenge },
						ariaLines: aria ? aria.split('\n').length : 0, ariaExcerpt: aria ? redact(session.id, aria.slice(0, 1200)) : undefined,
						console: log.console.length, pageErrors: log.pageErrors.length, failedRequests: log.failedRequests.length, requests: log.responses.length, screenshot: artifactId
					};
					await page.close();
					loaded = Boolean(mainResponse) && mainResponse.status < 500;
					break;
				} catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); }
			}
			state.loaded = loaded;
			if (!loaded) throw Object.assign(new Error(lastError ? `The site could not be loaded: ${String(lastError.message).split('\n')[0]}` : `The site responded with HTTP ${mainResponse?.status}.`), { expected: true });
			state.mainResponse = { status: mainResponse.status, headers: mainResponse.headers };
			return `HTTP ${mainResponse.status}`;
		}, () => {
			const obs = state.observation ?? {};
			const seen = Object.keys(obs.features ?? {}).filter(key => !['external_links', 'third_party', 'navigation'].includes(key));
			const auth = obs.auth ?? {};
			return `It's up (HTTP ${obs.status}${state.loadMs ? `, ${(state.loadMs / 1000).toFixed(1)} s` : ''}): "${obs.heading || obs.title || pathOf(obs.url)}" with ${plural(obs.controls ?? 0, 'control')}${seen.length ? ` and ${seen.join(', ')}` : ''}. ${auth.passwordForm ? 'The start page is a sign-in screen.' : auth.identifierStep ? 'The start page asks for a username first (two-step sign-in).' : auth.loginLinks?.length ? `There is a sign-in entry point (${auth.loginLinks[0]}).` : 'I saw no sign-in.'}`;
		});
		mainResponse ??= state.mainResponse;
		if (!loaded) throw Object.assign(new Error('target_unreachable'), { expected: true });

		// Stage B. Authenticate when sign-in exists (or an account was supplied). Re-done on resume:
		// browser sessions are not persisted.
		if (state.phases.signin?.status === 'done' && session.qaAuth?.authorized) state.phases.signin = undefined;
		if (session.qaAuth?.authorized || model.graph.auth.detected) await accountStep();
		else if (!state.phases.signin) state.phases.signin = { status: 'pending' };

		// Stage C. Discover: public pages signed out, then the signed-in area.
		await stage('discover', async deadline => {
			state.visited = [];
			pages.clear();
			const share = state.signedIn ? 0.45 : 1;
			const publicDeadline = Date.now() + (deadline - Date.now()) * share;
			await crawlPass(publicDeadline, [session.targetUrl], { maxPages: state.signedIn ? Math.ceil(options.maxPages / 2) : options.maxPages, discoveredBy: 'crawl', anonymous: Boolean(state.signedIn) });
			// A sign-in form found only while crawling: ask now (once), then map the signed-in area.
			if (!state.signedIn && state.coverage.loginForm && !['done', 'skipped'].includes(state.phases.signin?.status)) {
				model.setAuth({ detected: true });
				await accountStep();
			}
			if (state.signedIn && !stopped()) {
				const before = pages.size;
				state.visited = state.visited.filter(url => pages.has(url));
				await crawlPass(deadline, [state.signedInUrl, session.targetUrl].filter(Boolean), { maxPages: pages.size + Math.max(4, Math.ceil(options.maxPages / 2)), discoveredBy: 'signed-in' });
				state.coverage.signedInPages = pages.size - before;
			}
			// Walk the UI itself: sidebars, tabs and menus that navigate without links.
			if (!stopped() && Date.now() < deadline) {
				const starts = model.ranked(session.targetUrl, state.signedInUrl).filter(url => !model.page(url)?.login && (state.signedIn ? model.page(url)?.auth !== 'public' || url === state.signedInUrl : true)).slice(0, 4);
				const discovered = await discoverViews({
					browser, open: url => openPage(url), prepare: page => dismissOverlays(page, { cursor: (target, text) => browser.pointAt(page, target, text) }).catch(() => []), starts: starts.length ? starts : [state.signedInUrl ?? session.targetUrl], inScope: browser.inScope, deadline, maxScreens: options.uiScreens,
					knownTemplates: new Set(model.pages().map(routeTemplate)), progress,
					onView: async view => {
						if (view.kind === 'route') {
							model.addTransition(view.from, view.url, `click "${view.label}"`);
							await auditInto(view.url, { discoveredBy: state.signedIn ? 'signed-in' : 'crawl', depth: 1, from: view.from });
							if (model.page(view.url)) model.page(view.url).via = { from: view.from, label: view.label };
						} else model.addView(view);
					}
				}).catch(error => { console.warn('[qa-engine] UI walk failed:', error?.message); return []; });
				state.coverage.uiViews = discovered.length;
			}
			const stats = model.stats();
			return `${plural(stats.screens, 'screen')} mapped${stats.views ? `, ${plural(stats.views, 'panel')}` : ''}${stats.protected ? `, ${stats.protected} signed-in only` : ''}`;
		}, () => {
			const stats = model.stats();
			const features = Object.keys(stats.features).filter(key => !['external_links', 'third_party', 'navigation', 'headings'].includes(key));
			const views = model.graph.views.slice(0, 8).map(view => view.label);
			return `I mapped ${plural(stats.screens, 'screen')}${state.coverage.signedInPages ? ' including the signed-in area' : ''}${stats.views ? ` and ${plural(stats.views, 'panel/tab/dialog')} reached by clicking (${views.join(', ')}${stats.views > 8 ? '…' : ''})` : ''}. Features: ${features.join(', ') || 'basic pages only'}.`;
		});
		if (state.phases.signin?.status === 'pending') {
			state.phases.signin = { status: 'skipped', detail: model.graph.auth.detected ? 'Public pages only' : 'No sign-in found' };
			if (!model.graph.auth.detected) model.setAuth({ detected: false });
		}

		// Stage D. Plan from observation: graph × capability registry, plus reasoner journeys.
		await stage('plan', async () => {
			if (plan.scenarios.length) return `${plan.scenarios.length} scenarios (resumed plan)`;
			const derived = scenariosFromGraph({ graph: model, start: session.targetUrl, signedInUrl: state.signedInUrl, signedIn: Boolean(state.signedIn), options });
			const choice = router.decide('planning');
			let journeys = [];
			if (choice.model === 'reasoner') {
				const proposal = await proposeJourneys({ models, model, focus: session.testCaseSnapshot?.title ?? session.messages?.find(message => message.role === 'user')?.text?.slice(0, 500), signal, max: options.journeys });
				journeys = proposal.journeys.map(item => ({ ...item, origin: 'reasoner' }));
			}
			if (!journeys.length && baseModels.reasonerAvailable()) journeys = [{ ...fallbackJourney(model), origin: 'deterministic' }];
			if (!journeys.length) {
				router.record({ task: 'planning', model: 'deterministic', reason: 'No reasoning model: journeys were not planned; every other scenario comes from the graph.', fallback: true });
				limitation('plan', baseModels.state.reasoner.enabled ? `AI exploratory testing was unavailable (reasoning model error: ${baseModels.state.reasoner.lastError ?? 'no response'}); user journeys were not planned.` : 'AI exploratory testing was skipped: no reasoning model is configured, so user journeys were not planned.');
			}
			revisePlan(plan, derived.slice(0, options.maxScenarios), { trigger: `Initial plan from observing ${plural(model.stats().pages, 'page')}`, journeys });
			return `${plan.scenarios.length} scenarios`;
		}, () => {
			const units = {};
			for (const item of plan.scenarios) units[item.unit] = (units[item.unit] ?? 0) + 1;
			const journeys = plan.scenarios.filter(item => item.unit === 'explore');
			return `Plan: ${plural(plan.scenarios.length, 'scenario')} built from what I found${journeys.length ? `, including ${plural(journeys.length, 'user journey')} (${journeys.map(item => item.goal).slice(0, 2).join('; ')})` : ''}. It will change as I learn more.`;
		});

		// Stage E. Execute with continuous replanning.
		await stage('execute', async deadline => {
			let scenario;
			let ran = 0;
			while ((scenario = nextScenario(plan)) && !stopped()) {
				const remaining = deadline - Date.now();
				if (remaining <= 0) break;
				const pending = plan.scenarios.filter(item => item.state === 'pending').length;
				const weight = scenario.unit === 'explore' ? 3 : scenario.unit === 'visual' ? 2 : 1;
				const slice = Math.max(scenario.unit === 'explore' ? 180_000 : 20_000, remaining * weight / (pending + 2));
				await progress(scenario.title);
				await runScenario(scenario, Math.min(deadline, Date.now() + slice));
				ran++;
				const revision = await replan(`After "${scenario.title}"${state.discoveries?.length ? ` (found ${state.discoveries.slice(-2).join(', ')})` : ''}`);
				if (revision) await say(`I learned something new, so I updated the plan: +${plural(revision.added.length, 'scenario')} (${revision.added.slice(0, 3).map(id => plan.scenarios.find(item => item.id === id)?.title ?? id).join('; ')}).`, { id: `qa-replan-${revision.revision}-${state.startedAt}` });
				await flushUsage();
				await syncTodos();
				await persist({ checkpoint: true });
			}
			const summary = planSummary(plan);
			return `${ran} scenarios run (${summary.passed} passed, ${summary.failed} with possible issues)`;
		}, added => {
			const summary = planSummary(plan);
			return `I ran ${plural(summary.passed + summary.failed + summary.inconclusive + summary.not_applicable, 'scenario')}: ${summary.passed} clean, ${summary.failed} with ${describeCandidates(added)}${summary.inconclusive ? `, ${summary.inconclusive} inconclusive` : ''}${summary.pending ? `, ${summary.pending} not reached` : ''}. Verifying everything before it goes in the report.`;
		});
	} catch (error) {
		if (error?.policyBlocked) {
			limitation('observe', error.message, true);
		} else if (!error?.expected && !stopped()) {
			console.error('[qa-engine] unexpected failure; publishing what was collected:', error);
			limitation(state.phase, `The run hit an unexpected error during "${state.phase}" and published the results collected so far: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}`, true);
		}
	} finally {
		if (record) record.qaAnswer = undefined;
		if (session.pendingQuestion?.kind === 'qa_credentials') {
			session.pendingQuestion = undefined;
			try { await runStore.commit(session, 'question', { question: null }); } catch { /* best effort */ }
		}
		await browser?.close().catch(() => {});
	}

	// Triage and publish always run, even after a stop or failure.
	if (stopped()) limitation(state.phase, 'Stopped by the user before the plan finished; the report covers the work completed until then.', true);
	closeOutPlan(plan, stopped() ? 'Stopped by the owner before this scenario ran.' : !loaded ? 'The target could not be loaded.' : 'The run time budget ended before this scenario ran.');
	const notRun = plan.scenarios.filter(item => item.state === 'not_executed');
	if (notRun.length && loaded) limitation('execute', `${plural(notRun.length, 'planned scenario')} did not run (${notRun.slice(0, 4).map(item => item.title).join('; ')}${notRun.length > 4 ? '…' : ''}).`, true);
	for (const [id] of STAGES) if ((!state.phases[id] || ['pending', 'running'].includes(state.phases[id].status)) && !['triage', 'publish'].includes(id)) state.phases[id] = { status: 'skipped', detail: stopped() ? 'Stopped by user' : 'Not reached' };
	if (stopped() && session.status === 'awaiting_input') await runStore.setStatus(session, 'running', 'Publishing the results');
	state.phase = 'triage';
	state.phases.triage = { status: 'running', startedAt: Date.now() };
	await syncTodos();
	const triageActivity = randomUUID();
	try { await runStore.addActivity(session, { id: triageActivity, type: 'tool', toolName: 'qa_triage', status: 'running', label: label('triage') }); } catch { /* best effort */ }
	const blockedContext = blocked.writes || blocked.offsite ? `${blocked.writes} write requests and ${blocked.offsite} off-site navigations were blocked during testing (e.g. ${blocked.samples.slice(0, 3).map(item => `${item.method} ${item.url}`).join(', ')}).` : '';
	let result;
	let triaged = false;
	router.decide('verification');
	try {
		result = await triage({ candidates: state.candidates, models, context: { target: session.targetUrl, pages: state.coverage.pages, viewports: state.coverage.viewports, blocked: blockedContext }, deadline: Date.now() + 240_000, onDecision: entry => router.record(entry), escalationBand: ESCALATION_BAND });
		state.phases.triage = { status: 'done', detail: `${result.findings.length} confirmed of ${result.stats.merged}${result.stats.escalated ? `, ${result.stats.escalated} escalated` : ''}`, startedAt: state.phases.triage.startedAt, endedAt: Date.now() };
		triaged = true;
	} catch (error) {
		console.warn('[qa-engine] triage failed, using deterministic confidence:', error);
		result = { findings: state.candidates.filter(item => item.source === 'detector' && item.confidence >= 0.7), dismissed: [], stats: { candidates: state.candidates.length, verifiedBy: [], unverified: state.candidates.length } };
		state.phases.triage = { status: 'failed', detail: 'Verification failed; deterministic confidence used' };
		limitation('triage', 'Model verification failed; findings were selected by detector confidence only.');
		triaged = true;
	}
	try { await runStore.updateActivity(session, triageActivity, { status: 'done', summary: state.phases.triage.detail }); } catch { /* best effort */ }
	if (!result.stats.verifiedBy?.length && result.stats.merged) limitation('triage', `Neither JEV nor the reasoning model was available to verify candidates (${baseModels.state.jev.lastError ?? baseModels.state.reasoner.lastError ?? 'no model configured'}); findings were selected by detector confidence.`);
	if (model.graph.auth.detected && !state.signedIn) limitation('signin', `The site has sign-in; pages behind it were not tested${model.graph.auth.blockedReason ? `: ${model.graph.auth.blockedReason}` : '.'}`, true);
	if (blocked.writes && !state.allowWrites) limitation('forms', `QASE blocked ${blocked.writes} write request${blocked.writes === 1 ? '' : 's'} during interaction so no data was changed; server-side handling of submitted data was not tested.`);

	// Final scenario outcomes follow verification: a scenario fails only through a confirmed finding.
	const confirmedBy = new Map();
	for (const item of result.findings) for (const id of item.scenarioIds ?? (item.scenarioId ? [item.scenarioId] : [])) confirmedBy.set(id, (confirmedBy.get(id) ?? 0) + 1);
	for (const scenario of plan.scenarios) {
		if (scenario.state !== 'failed') continue;
		scenario.findings = confirmedBy.get(scenario.id) ?? 0;
		if (!scenario.findings) { scenario.state = 'passed'; scenario.reason = `${plural(scenario.candidates ?? 0, 'possible issue')} dismissed by verification.`; }
		else scenario.reason = `${plural(scenario.findings, 'confirmed finding')}.`;
	}
	const verifier = result.stats.verifiedBy?.includes('jev') ? 'JEV' : result.stats.verifiedBy?.includes('reasoner') ? 'The reasoning model' : '';
	await say(verifier
		? `${verifier} checked ${plural(result.stats.merged ?? 0, 'possible issue')} (duplicates across pages and viewports merged): **${result.findings.length} confirmed**, ${result.dismissed.length} dismissed as false positives or test side-effects${result.stats.escalated ? `; ${result.stats.escalated} uncertain verdict(s) were escalated to the reasoning model` : ''}.`
		: `I grouped ${plural(result.stats.merged ?? 0, 'possible issue')} and kept the ${result.findings.length} backed by high-confidence automated checks (no model was available to verify the rest).`, { id: `qa-step-triage-${state.startedAt}` });

	state.phase = 'publish';
	state.phases.publish = { status: 'running', startedAt: Date.now() };
	await syncTodos();
	try {
		const refined = await refineWithReasoner({ models, target: session.targetUrl, findings: result.findings, coverage: state.coverage, limitations: state.limitations, signal: AbortSignal.timeout(150_000) }).catch(() => ({}));
		const published = [];
		for (const [index, item] of result.findings.entries()) {
			const fix = refined.fixes?.get(index) ?? item.fix ?? DEFAULT_FIX[item.category] ?? DEFAULT_FIX.functional;
			const finding = redact(session.id, {
				id: randomUUID(), ts: Date.now(), title: item.title, severity: item.severity, category: item.category, url: item.url,
				steps: item.steps, expected: item.expected || 'The page behaves correctly.', actual: item.actual,
				evidence: [item.evidence, item.viewports?.length ? `Reproduced at: ${item.viewports.join(', ')}` : '', item.urls?.length > 1 ? `Also on: ${item.urls.slice(1, 6).join(', ')}` : '', item.verification ? `Verified by ${item.verification.by} (p=${item.verification.probability}${item.verification.escalatedFrom ? `, escalated from JEV p=${item.verification.escalatedFrom.probability}` : ''})${item.verification.reason ? `: ${item.verification.reason}` : ''}` : 'Not model-verified (detector confidence)'].filter(Boolean).join('\n'),
				engine: session.engine, status: 'open', statusTs: Date.now(), statusNote: '',
				selector: item.selector, viewports: item.viewports, fix, artifactId: item.artifactId, source: item.source, detector: item.detector, score: item.score, scenarioIds: item.scenarioIds
			});
			state.findingDetails[finding.id] = { selector: finding.selector, viewports: finding.viewports, fix: finding.fix, artifactId: finding.artifactId, source: finding.source, detector: finding.detector, score: finding.score };
			session.findings = [...(session.findings ?? []), finding];
			published.push(finding);
			try { await runStore.commit(session, 'finding', { finding }); } catch (error) { console.warn('[qa-engine] finding commit failed:', error?.message); }
		}
		// Capability coverage (140 categories) and the completion gate, both deterministic.
		const unitRan = { observe: Boolean(state.observation), page_audit: pages.size > 0, signin: Boolean(state.signedIn) };
		const coverageRows = capabilityCoverage({ graph: model.graph, units: unitOutcomes(plan, unitRan), findings: published, dismissed: result.dismissed, signedIn: Boolean(state.signedIn), viewportsTested: state.coverage.viewportNames });
		state.capabilitySummary = { total: CAPABILITY_COUNT, ...summarizeCoverage(coverageRows) };
		const gate = evaluateCompletion({ state, plan, graph: model.graph, coverageRows, findings: published, triaged, stopped: stopped() });
		state.gate = gate;
		const report = redact(session.id, buildReport({ session, findings: published, dismissed: result.dismissed, coverage: state.coverage, limitations: state.limitations, models: baseModels, triageStats: result.stats, loaded, refined,
			runtime: { engine: session.runtimeFacts?.launchedEngineId, version: session.runtimeFacts?.browserVersion },
			adaptive: { gate, plan, graph: model.graph, observation: state.observation, coverageRows, routing: router.state(), routingSummary: router.summary(), authEvents: state.authEvents, signedIn: Boolean(state.signedIn), blocked } }));
		session.report = report;
		state.status = 'done';
		state.phases.publish = { status: 'done', detail: `${published.length} findings, verdict ${report.verdict}, gate ${gate.status}`, startedAt: state.phases.publish.startedAt, endedAt: Date.now() };
		await syncTodos();
		await persist({ checkpoint: true });
		await runStore.commit(session, 'report', { report });
		await flushUsage();
		const ordered = [...published].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
		for (const finding of ordered.slice(0, 15)) await say(`**${finding.severity.toUpperCase()}** · ${finding.title}`, { kind: 'qa-finding', id: `qaf-${finding.id}` });
		if (ordered.length > 15) await say(`…and ${plural(ordered.length - 15, 'more finding')} in the Findings tab and the report.`, { id: `qa-more-${report.ts}` });
		const cov = state.capabilitySummary;
		await say(`Completion gate: **${gate.status}**${gate.failed.length ? ` (open: ${gate.failed.join(', ')})` : ''}. Coverage of ${cov.total} test categories: ${cov.passed} passed, ${cov.failed} failed, ${cov.blocked} blocked, ${cov.inconclusive} inconclusive, ${cov.not_applicable} not applicable, ${cov.unsupported} unsupported, ${cov.not_executed} not executed.`, { id: `qa-gate-${report.ts}` });
		await say(`${report.summary}`, { kind: 'qa-report', id: `qa-report-${report.ts}` });
		await runStore.setStatus(session, 'done');
	} catch (error) {
		console.error('[qa-engine] publish failed:', error);
		state.status = 'error';
		await persist({ checkpoint: true });
		await runStore.setStatus(session, 'error', `The report could not be saved: ${String(error?.message ?? error).slice(0, 200)}`);
	}
}
