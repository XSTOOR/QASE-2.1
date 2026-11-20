/**
 * QASE QA engine (v2).
 *
 * A host-orchestrated pipeline. Deterministic detectors do the measuring; the
 * reasoning model explores and reviews visuals; JEV verifies and grades.
 *
 *   1. open      load the target, capture headers/cookies, start live view
 *      signin    ask the owner for a test account when the site has a sign-in
 *                wall (secure card in the conversation), then sign in once
 *   2. crawl     discover same-scope pages; audit each in the primary viewport
 *   3. viewports re-audit key pages on desktop / mobile (responsive)
 *   4. motion    click toggles, menus, dialogs; hover submenus; reduced motion
 *   5. forms     empty / malformed input, never submitted
 *   6. security  headers, cookies, CORS, exposed files, injection probes
 *   7. links     broken internal / external links
 *   8. explore   reasoning-model exploratory testing of user journeys
 *   9. visual    reasoning-model review of screenshots and animation filmstrips
 *  10. triage    merge, verify (JEV → reasoner → deterministic), grade
 *  11. publish   findings with fix guidance, report, verdict
 *
 * The agent talks: each phase ends with a short message in the conversation,
 * confirmed findings are posted as cards and the run ends with a report card.
 *
 * Completion guarantee: each phase runs inside its own try/catch with its own
 * adaptive share of the remaining run budget (time a phase does not use flows
 * to later phases; time spent waiting for the owner is not counted). A failing phase becomes a recorded limitation,
 * never a terminal state. A user stop or any unexpected error still publishes a
 * partial report. Phase progress is checkpointed so a process restart resumes
 * after the last completed phase.
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
import { signIn, hasLoginForm } from './signin.js';
import { buildReport, refineWithReasoner } from './report.js';

export const ENGINE_VERSION = 2;

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

const PHASES = [
	['open', 'Open the site and capture its security posture'],
	['signin', 'Sign in with the test account (when provided)'],
	['crawl', 'Discover pages and audit layout, content, accessibility and errors'],
	['viewports', 'Re-test key pages on desktop and mobile'],
	['motion', 'Test menus, toggles, dialogs and their animations'],
	['forms', 'Test form validation without submitting data'],
	['security', 'Run non-destructive security probes'],
	['links', 'Check every link'],
	['explore', 'Explore user journeys with the reasoning model'],
	['visual', 'Review screenshots and animations visually'],
	['triage', 'Verify and grade candidate defects (JEV)'],
	['publish', 'Publish findings, fix prompts and the report']
];

// Relative share of the remaining budget each phase may use. A phase's deadline is
// its share of the time left, so unused time flows to the phases that follow.
const PHASE_SHARE = { open: 6, signin: 10, crawl: 20, viewports: 9, motion: 13, forms: 6, security: 8, links: 3, explore: 13, visual: 6, triage: 4, publish: 2 };
const PHASE_IDS = PHASES.map(([id]) => id);

const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const pathOf = url => { try { const parsed = new URL(url); return `${parsed.pathname}${parsed.search}` || '/'; } catch { return url; } };

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
		visualShots: positive(env.QASE_QA_VISUAL_SHOTS, 8, 30),
		maxArtifacts: positive(env.QASE_QA_MAX_ARTIFACTS, 120, 500),
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
	return {
		version: state.version, engine: state.engine, status: state.status, phase: state.phase,
		phases: PHASES.map(([id, label]) => ({ id, label, status: state.phases?.[id]?.status ?? 'pending', detail: state.phases?.[id]?.detail })),
		coverage: state.coverage, limitations: state.limitations, models: state.models,
		candidates: state.candidates?.length ?? 0, startedAt: state.startedAt, updatedAt: state.updatedAt
	};
}

/** Run state created at launch; allowWrites/auth are the owner's choices for this run. */
export function createQaState({ allowWrites = false, auth } = {}) {
	return { ...initialState(), allowWrites: allowWrites === true, auth: auth ? { authorized: auth.authorized === true, loginUrl: auth.loginUrl, expectedUrl: auth.expectedUrl } : undefined };
}

function initialState() {
	return {
		version: ENGINE_VERSION, engine: 'qase-qa-engine', status: 'running', startedAt: Date.now(), updatedAt: Date.now(),
		phase: 'open', phases: {}, visited: [], candidates: [], limitations: [], findingDetails: {}, models: {},
		coverage: { pages: 0, viewports: [], interactions: 0, hoverMenus: 0, forms: 0, securityChecks: 0, injectionUrls: 0, linksChecked: 0, exploration: 0, visualReviews: 0 }
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
	if (session.hybrid?.version !== ENGINE_VERSION) session.hybrid = initialState();
	const state = session.hybrid;
	session.qaAuth ??= state.auth;
	state.status = 'running';
	state.resumedAt = state.phases.open ? Date.now() : undefined;
	const started = Date.now();
	const elapsedBefore = state.elapsedMs ?? 0;
	const budgetMs = Math.max(120_000, options.budgetMs - elapsedBefore);
	let pausedMs = 0; // time spent waiting for the owner does not consume the budget
	const budgetEnd = () => started + budgetMs + pausedMs;
	const phaseDeadline = phase => {
		const remaining = Math.max(0, budgetEnd() - Date.now());
		const index = PHASE_IDS.indexOf(phase);
		const pending = PHASE_IDS.slice(index).filter(id => id === phase || !['done', 'skipped', 'failed'].includes(state.phases[id]?.status));
		const total = pending.reduce((sum, id) => sum + PHASE_SHARE[id], 0) || 1;
		return Date.now() + remaining * PHASE_SHARE[phase] / total;
	};
	let artifacts = 0;

	// checkpoint=true marks a durable checkpoint (phase boundaries); other updates are batched.
	const persist = async ({ checkpoint = false } = {}) => {
		state.updatedAt = Date.now();
		state.elapsedMs = elapsedBefore + (Date.now() - started) - pausedMs;
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
	const save = async (bytes, label) => {
		if (!bytes || artifacts >= options.maxArtifacts) return undefined;
		try {
			artifacts++;
			return artifactStore.save(session, { type: 'screenshot', fileName: 'evidence.jpg', bytes, label: String(label).slice(0, 200) }).artifactId;
		} catch { return undefined; }
	};
	const usage = [];
	const models = createQaModels({ settings, state: state.models, fetchImpl: modelFetch, onUsage: entry => usage.push(entry), log: line => console.warn(`[qa-engine] ${line}`) });
	const flushUsage = async () => {
		if (!usage.length) return;
		const { applyUsage } = await import('../usageCapture.js');
		for (const entry of usage.splice(0)) session.tokenUsage = applyUsage(session.tokenUsage, entry);
		try { await runStore.commit(session, 'usage', { usage: session.tokenUsage, mode: session.mode }); } catch { /* usage display is best effort */ }
	};
	const todos = () => PHASES.map(([id, label]) => ({ id, text: label, status: state.phases[id]?.status === 'done' || state.phases[id]?.status === 'skipped' || state.phases[id]?.status === 'failed' ? 'completed' : state.phases[id]?.status === 'running' ? 'in_progress' : 'pending' }));
	const syncTodos = async () => {
		session.todos = todos();
		try { await runStore.commit(session, 'todos', { todos: session.todos }); } catch { /* plan view is best effort */ }
	};
	const limitation = (phase, message, affectsCoverage = false) => {
		if (!state.limitations.some(item => item.message === message)) state.limitations.push({ phase, message: String(message).slice(0, 500), affectsCoverage });
	};
	const addCandidates = items => {
		for (const item of items ?? []) if (state.candidates.length < 1500) state.candidates.push(redact(session.id, item));
	};

	let browser;
	let fetchImpl = probeFetch;
	const blocked = { writes: 0, offsite: 0, samples: [] };
	const stopped = () => signal?.aborted;

	async function phase(id, work, narrate) {
		if (['done', 'skipped'].includes(state.phases[id]?.status)) return;
		if (stopped()) { state.phases[id] = { status: 'skipped', detail: 'Stopped by user' }; return; }
		state.phase = id;
		state.phases[id] = { status: 'running', startedAt: Date.now() };
		await syncTodos();
		await persist();
		const activityId = randomUUID();
		currentActivity = activityId;
		const before = state.candidates.length;
		try { await runStore.addActivity(session, { id: activityId, type: 'tool', toolName: `qa_${id}`, status: 'running', label: PHASES.find(([key]) => key === id)[1] }); } catch { /* feed is best effort */ }
		let detail;
		try {
			if (Date.now() >= phaseDeadline(id) && !['triage', 'publish'].includes(id)) {
				state.phases[id] = { status: 'skipped', detail: 'Run time budget reached' };
				limitation(id, `${PHASES.find(([key]) => key === id)[1]} was skipped because the run time budget was reached.`, ['crawl', 'motion', 'security'].includes(id));
			} else {
				detail = await work(phaseDeadline(id));
				// A phase that decided not to run (e.g. no model configured) reports "skipped …".
				state.phases[id] = { status: /^skipped/i.test(detail ?? '') ? 'skipped' : 'done', detail: detail ?? undefined, endedAt: Date.now() };
			}
		} catch (error) {
			if (stopped()) {
				state.phases[id] = { status: 'skipped', detail: 'Stopped by user' };
			} else {
				const message = String(error?.message ?? error).split('\n')[0].slice(0, 300);
				console.warn(`[qa-engine] phase ${id} failed:`, error);
				state.phases[id] = { status: 'failed', detail: message };
				limitation(id, `${PHASES.find(([key]) => key === id)[1]} did not complete: ${message}`, ['open', 'crawl'].includes(id));
			}
		}
		currentActivity = undefined;
		try { await runStore.updateActivity(session, activityId, { status: state.phases[id].status === 'failed' ? 'error' : 'done', summary: state.phases[id].detail ?? state.phases[id].status, detail: '' }); } catch { /* best effort */ }
		const added = state.candidates.slice(before);
		if (state.phases[id].status === 'done' && narrate) {
			const text = narrate(added, state.phases[id].detail);
			if (text) await say(text, { id: `qa-step-${id}-${state.startedAt}` });
		} else if (state.phases[id].status === 'failed') {
			await say(`I couldn't finish this step (${PHASES.find(([key]) => key === id)[1].toLowerCase()}): ${state.phases[id].detail}. I'm carrying on with the rest of the test; the report will list what was missed.`, { id: `qa-step-${id}-${state.startedAt}` });
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

	/**
	 * Pauses the run and asks the owner for a test account through the secure
	 * card in the conversation. Resolves { credentials } | { skip } | { timeout } | { stopped }.
	 * The waiting time is excluded from the run budget.
	 */
	async function askForAccount({ retry = false, reason } = {}) {
		const question = {
			kind: 'qa_credentials', credentialLike: true, options: [], allowCustom: false,
			question: retry ? 'Signing in didn\'t work. Try another test account?' : `${host} has a sign-in page. Should I test the signed-in part too?`,
			summary: retry
				? `${reason ? `${reason}. ` : ''}Check the username and password, or continue with the public pages only.`
				: `So far I can test only the public pages. Give me a test account and I'll sign in once and test what's behind it, read-only: I won't submit forms, change settings or delete anything. Skip and I'll finish with the public pages.`
		};
		session.pendingQuestion = question;
		state.awaitingCredentials = true;
		try { await runStore.commit(session, 'question', { question }); } catch { /* the card is best effort; the wait still times out */ }
		await runStore.setStatus(session, 'awaiting_input', 'Waiting for a test account');
		const waitStart = Date.now();
		const answer = await new Promise(resolve => {
			const done = value => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); if (record) record.qaAnswer = undefined; resolve(value); };
			const timer = setTimeout(() => done({ timeout: true }), options.credentialWaitMs);
			timer.unref?.();
			const onAbort = () => done({ stopped: true });
			if (signal?.aborted) return done({ stopped: true });
			signal?.addEventListener('abort', onAbort, { once: true });
			if (record) record.qaAnswer = done;
		});
		pausedMs += Date.now() - waitStart;
		state.awaitingCredentials = false;
		session.pendingQuestion = undefined;
		try { await runStore.commit(session, 'question', { question: null }); } catch { /* best effort */ }
		if (!answer.stopped) await runStore.setStatus(session, 'running', 'Testing the site');
		if (answer.credentials) session.qaAuth = { ...(session.qaAuth ?? {}), authorized: true, ...(answer.credentials.loginUrl ? { loginUrl: answer.credentials.loginUrl } : {}) };
		if (answer.skip || answer.timeout) state.credentialsDeclined = true;
		if (answer.timeout) await say(`I didn't get an answer within ${Math.round(options.credentialWaitMs / 60000)} minutes, so I'm continuing with the public pages. Start a new run with a test account to cover the signed-in area.`);
		else if (answer.skip) await say('OK, I\'ll test the public pages only.');
		return answer;
	}

	/** Signs in with the vault credentials. Returns true when signed in. */
	async function signInOnce() {
		const authRoutes = await discoverAuthRoutes(new URL(session.targetUrl).origin, { fetchImpl }).catch(() => []);
		const outcome = await signIn({ browser, profile: primary, session, candidates: [state.loginUrl, session.targetUrl, ...pageList().filter(url => pages.get(url)?.login), ...authRoutes.filter(url => !/logout|redirect|out$/.test(url))].filter(Boolean) });
		state.signedIn = outcome.ok;
		if (outcome.ok) state.signedInUrl = outcome.url;
		return outcome;
	}

	/**
	 * The sign-in step: uses a test account supplied at launch, or asks for one
	 * when the site has a sign-in form. A failed sign-in is re-asked once.
	 */
	async function accountStep() {
		const needsAsk = !session.qaAuth?.authorized && !state.credentialsDeclined && options.askForCredentials && !session.matrixRunId;
		if (!session.qaAuth?.authorized && !needsAsk) return false;
		let signedIn = false;
		state.phases.signin = undefined;
		await phase('signin', async () => {
			if (!session.qaAuth?.authorized) {
				const answer = await askForAccount();
				if (!answer.credentials) return answer.stopped ? 'skipped (stopped by user)' : 'skipped (public pages only)';
				await say('Thanks, I have the test account. Signing in…');
			}
			for (let attempt = 0; attempt < 2; attempt++) {
				const outcome = await signInOnce();
				if (outcome.ok) {
					signedIn = true;
					await say(`Signed in. I'm testing the signed-in area too (read-only), starting at \`${pathOf(outcome.url)}\`.`);
					return 'signed in';
				}
				// Ask for another account only when the site actually rejected this one;
				// a CAPTCHA, a missing form or a failed request will not be fixed by retyping.
				if (attempt === 1 || outcome.retry === false || !options.askForCredentials || session.matrixRunId) {
					limitation('signin', `Signed-in areas were not tested. ${outcome.reason} Public pages were tested instead.`, true);
					await say(`I couldn't sign in. ${outcome.reason} I'll continue with the public pages; the report lists this as not tested.`);
					return 'public only';
				}
				await say(`That didn't work. ${outcome.reason}`);
				const retry = await askForAccount({ retry: true, reason: outcome.reason.replace(/\.$/, '') });
				if (!retry.credentials) {
					limitation('signin', `Signed-in areas were not tested. ${outcome.reason}`, true);
					return 'public only';
				}
				await say('Trying the new test account…');
			}
			return 'public only';
		});
		return signedIn;
	}

	const pageList = () => [...pages.keys()];

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
		if (!await browser.policyAllows(session.targetUrl, true)) throw Object.assign(new Error('The target is blocked by the browser safety policy (private or reserved network address). Allow it with QASE_BROWSER_ALLOWED_PRIVATE_HOSTS if it is an approved internal target.'), { policyBlocked: true });
		browser.startFrames();
		session.runtimeFacts = { ...(session.runtimeFacts ?? {}), launchedEngineId: browser.engine, browserVersion: browser.version, executionLevel: session.runtimeFacts?.executionLevel ?? 'SIMULATED', capturedAt: Date.now() };
		state.coverage.engine = `${browser.engine} ${browser.version}`;
		const browserName = browser.engine === 'chromium' ? `Chrome ${String(browser.version).split('.')[0]}` : `${browser.engine} ${browser.version}`;
		const modelPlan = [models.reasonerAvailable() ? 'explore key journeys and review screenshots with the reasoning model' : '', models.jevAvailable() ? 'verify every possible issue with JEV before reporting it' : ''].filter(Boolean);
		await say(`I'm testing **${host}** in ${browserName} on ${primary.label}. I'll crawl the site and check layout, overlapping elements, animations, forms, accessibility, links and security, then ${modelPlan.length ? modelPlan.join(' and ') : 'verify what I find'}. I'll post what I find as I go.`, { id: `qa-intro-${state.startedAt}` });

		const open = async (url, settleOptions) => {
			const { page, log } = await browser.openPage(primary);
			await browser.goto(page, url, log, settleOptions);
			return { page, log };
		};

		// 1. Open
		await phase('open', async () => {
			let attempt = 0;
			let lastError;
			while (attempt++ < 3 && !stopped()) {
				try {
					const { page, log } = await open(session.targetUrl);
					mainResponse = log.mainResponse;
					cookies = await page.context().cookies();
					// A visible password field on the landing page means a sign-in wall.
					state.loginWall = await hasLoginForm(page);
					if (state.loginWall) state.loginUrl = page.url();
					state.loadMs = await page.evaluate(() => Math.round(performance.getEntriesByType('navigation')[0]?.loadEventEnd || 0)).catch(() => 0);
					await page.close();
					loaded = Boolean(mainResponse) && mainResponse.status < 500;
					break;
				} catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); }
			}
			state.loaded = loaded;
			if (!loaded) throw new Error(lastError ? `The site could not be loaded: ${String(lastError.message).split('\n')[0]}` : `The site responded with HTTP ${mainResponse?.status}.`);
			state.mainResponse = { status: mainResponse.status, headers: mainResponse.headers };
			return `HTTP ${mainResponse.status}`;
		}, () => `The site is up (HTTP ${mainResponse?.status ?? state.mainResponse?.status}${state.loadMs ? `, loaded in ${(state.loadMs / 1000).toFixed(1)} s` : ''}).${state.loginWall ? ' The start page is a sign-in screen.' : ''}`);
		mainResponse ??= state.mainResponse;
		if (!loaded) throw Object.assign(new Error('target_unreachable'), { expected: true });

		// 1b. Sign-in: supplied at launch, or asked for now when the start page is a sign-in wall.
		// Re-done on resume because browser state is not persisted.
		if (state.phases.signin?.status === 'done' && session.qaAuth?.authorized) state.phases.signin = undefined;
		if (session.qaAuth?.authorized || state.loginWall) await accountStep();
		else if (!state.phases.signin) state.phases.signin = { status: 'pending' };

		// 2. Crawl + primary audit
		const crawlPass = async (deadline, starts, maxPages = options.maxPages) => {
			const frontier = createFrontier({ start: starts[0], inScope: browser.inScope, maxPages });
			for (const url of starts.slice(1)) frontier.add(url);
			frontier.restore(state.visited);
			let url;
			let audited = 0;
			while ((url = frontier.next()) && pages.size < maxPages && Date.now() < deadline && !stopped()) {
				if (state.visited.includes(url) && pages.has(url)) continue;
				await progress(`Auditing ${pathOf(url)}`);
				let page, log;
				try {
					({ page, log } = await open(url));
				} catch (error) {
					addCandidates([candidate({ detector: 'page.unreachable', category: 'functional', severity: 'high', confidence: 0.7, title: `Page fails to load: ${new URL(url).pathname}`,
						url, viewport: primary.name, actual: String(error.message).split('\n')[0], expected: 'The page loads.', steps: [`Open ${url}`], data: { key: url } })]);
					state.visited.push(url);
					continue;
				}
				try {
					const finalUrl = normalizeUrl(page.url(), url) ?? url;
					if (finalUrl !== url && (state.visited.includes(finalUrl) || pages.has(finalUrl))) { await page.close(); state.visited.push(url); continue; }
					const status = log.mainResponse?.status ?? 200;
					if (status >= 400) {
						// Missing pages are reported once by the link checker; server errors are defects here.
						if (status >= 500) addCandidates([candidate({ detector: 'page.http_error_page', category: 'functional', severity: 'critical', confidence: 0.95, title: `Page returns HTTP ${status}`, url: finalUrl, viewport: primary.name,
							actual: `${finalUrl} responded with HTTP ${status}.`, expected: 'The page loads successfully.', steps: [`Open ${finalUrl}`], fix: 'Fix the server error for this route and serve a helpful error page.', data: { key: String(status) } })]);
						state.visited.push(url);
						continue;
					}
					const result = await auditPage(page, { url: finalUrl, viewport: primary.name, touch: primary.hasTouch, log, save });
					addCandidates(result.candidates);
					addCandidates(await auditPageSecurity(page, { url: finalUrl, viewport: primary.name, fetchImpl }).catch(() => []));
					state.coverage.securityChecks += 7; // libraries, secrets, source maps, CSRF, credentials, tab-nabbing, debug output
					const login = await hasLoginForm(page);
					if (login) { state.coverage.loginForm = true; state.loginUrl ??= finalUrl; }
					await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
					const shot = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => undefined);
					if (shot && shots.length < options.visualShots) shots.push({ url: finalUrl, viewport: primary.label, bytes: shot });
					for (const link of result.metrics?.links ?? []) {
						const normalized = normalizeUrl(link.href, finalUrl);
						if (!normalized) continue;
						if (!links.has(normalized)) links.set(normalized, { text: link.text, pages: [] });
						const entry = links.get(normalized);
						if (entry.pages.length < 10 && !entry.pages.includes(finalUrl)) entry.pages.push(finalUrl);
						frontier.add(normalized, finalUrl);
					}
					pages.set(finalUrl, { title: result.metrics?.title, forms: result.metrics?.forms ?? 0, controls: result.metrics?.controls ?? 0, params: [...new URL(finalUrl).searchParams.keys()], login, signedIn: Boolean(state.signedIn) });
					audited++;
					state.visited.push(url);
					if (finalUrl !== url) state.visited.push(finalUrl);
					state.coverage.pages = pages.size;
					state.pages = Object.fromEntries(pages);
					state.links = Object.fromEntries([...links].slice(0, 400));
					await persist();
				} finally {
					await page.close().catch(() => {});
				}
			}
			if (!state.coverage.viewports.includes(primary.label)) state.coverage.viewports.push(primary.label);
			if (frontier.size > pages.size && pages.size >= maxPages) limitation('crawl', `Crawled the first ${pages.size} pages (limit QASE_QA_MAX_PAGES=${options.maxPages}); ${frontier.size - pages.size} more discovered pages were not audited.`);
			return audited;
		};
		const describePages = list => {
			const paths = list.map(pathOf);
			return paths.length <= 5 ? paths.map(item => `\`${item}\``).join(', ') : `${paths.slice(0, 5).map(item => `\`${item}\``).join(', ')} and ${paths.length - 5} more`;
		};
		await phase('crawl', async deadline => {
			// An interrupted crawl restarts from the target; merged fingerprints absorb repeats.
			state.visited = [];
			pages.clear();
			await crawlPass(deadline, [session.targetUrl, state.signedInUrl].filter(Boolean));
			return `${plural(pages.size, 'page')} audited`;
		}, added => `I crawled and audited ${plural(pages.size, 'page')} on ${primary.label}${pages.size ? ` (${describePages(pageList())})` : ''}: ${describeCandidates(added)}. I'll verify everything before it goes in the report.`);

		// 2b. A sign-in form found while crawling (not on the start page): ask now, then crawl the signed-in area.
		if (!state.signedIn && state.coverage.loginForm && state.phases.signin?.status === 'pending') {
			const signedIn = await accountStep();
			if (signedIn && !stopped()) {
				state.phases.crawl2 = undefined;
				const before = pages.size;
				const beforeCandidates = state.candidates.length;
				const deadline = Date.now() + Math.max(60_000, (budgetEnd() - Date.now()) * 0.25);
				// The signed-in area gets its own page allowance on top of the public crawl.
				await crawlPass(deadline, [state.signedInUrl, session.targetUrl].filter(Boolean), pages.size + Math.max(4, Math.ceil(options.maxPages / 2))).catch(error => limitation('crawl', `Crawling the signed-in area stopped early: ${String(error.message).split('\n')[0].slice(0, 160)}`));
				await say(pages.size > before
					? `In the signed-in area I audited ${plural(pages.size - before, 'more page')} (${describePages(pageList().slice(before))}): ${describeCandidates(state.candidates.slice(beforeCandidates))}.`
					: 'The signed-in area had no new pages beyond the ones I already audited.');
				await persist({ checkpoint: true });
			}
		}
		if (state.phases.signin?.status === 'pending') state.phases.signin = { status: 'skipped', detail: state.coverage.loginForm ? 'Public pages only' : 'No sign-in form found' };
		const keyPages = pageList().slice(0, options.secondaryPages);

		// 3. Secondary viewports
		await phase('viewports', async deadline => {
			for (const profile of secondary) {
				for (const url of keyPages) {
					if (Date.now() >= deadline || stopped()) break;
					await progress(`Checking ${pathOf(url)} on ${profile.label}`);
					const { page, log } = await browser.openPage(profile);
					try {
						await browser.goto(page, url, log);
						addCandidates((await auditPage(page, { url, viewport: profile.name, touch: profile.hasTouch, log, save })).candidates);
						await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
						const shot = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => undefined);
						if (shot && shots.length < options.visualShots + 4 && profile.isMobile) shots.push({ url, viewport: profile.label, bytes: shot });
					} catch { /* one page failing is recorded by its own candidates */ }
					finally { await page.close().catch(() => {}); }
				}
				if (!state.coverage.viewports.includes(profile.label)) state.coverage.viewports.push(profile.label);
			}
			return state.coverage.viewports.join(', ');
		}, added => `I re-tested ${plural(keyPages.length, 'key page')} on ${secondary.map(profile => profile.label).join(' and ')}: ${describeCandidates(added)}.`);

		// 4. Motion and interactions
		await phase('motion', async deadline => {
			const profiles = [primary, ...secondary.filter(profile => profile.isMobile).slice(0, 1)];
			for (const profile of profiles) {
				for (const url of pageList().slice(0, options.interactionPages)) {
					if (Date.now() >= deadline || stopped()) break;
					await progress(`Clicking menus and toggles on ${pathOf(url)} (${profile.label})`);
					const { page, log } = await browser.openPage(profile);
					browser.setActivePage(page);
					try {
						await browser.goto(page, url, log);
						const reload = async () => { await browser.goto(page, url, log, { quietMs: 800 }).catch(() => {}); };
						const result = await testInteractions(page, { url, viewport: profile.name, browser, reload, save, limit: options.triggersPerPage, deadline });
						addCandidates(result.candidates);
						state.coverage.interactions += result.tested;
						filmstrips.push(...result.filmstrips);
						if (!profile.isMobile && Date.now() < deadline) {
							await reload();
							const hover = await testHoverMenus(page, { url, viewport: profile.name, save });
							addCandidates(hover);
							state.coverage.hoverMenus += 1;
						}
					} catch (error) {
						limitation('motion', `Interaction testing on ${url} (${profile.name}) stopped early: ${String(error.message).split('\n')[0].slice(0, 160)}`);
					} finally { await page.close().catch(() => {}); }
					await persist();
				}
			}
			// Reduced motion on the start page.
			if (Date.now() < deadline) {
				const { page, log } = await browser.openPage(primary, { reducedMotion: 'reduce' });
				try {
					await browser.goto(page, state.signedInUrl ?? session.targetUrl, log);
					await page.waitForTimeout(600);
					addCandidates(await testReducedMotion(page, { url: state.signedInUrl ?? session.targetUrl, viewport: primary.name }));
				} catch { /* optional check */ } finally { await page.close().catch(() => {}); }
			}
			filmstrips = filmstrips.slice(0, 8);
			return `${state.coverage.interactions} controls tested`;
		}, added => `I clicked ${plural(state.coverage.interactions, 'control')} (menus, toggles, dialogs, accordions) and measured how they open, close and animate${state.coverage.hoverMenus ? ', hovered the navigation submenus' : ''} and checked reduced motion: ${describeCandidates(added)}.`);

		// 5. Forms
		await phase('forms', async deadline => {
			for (const url of pageList().filter(url => (pages.get(url)?.forms ?? 0) > 0).slice(0, 6)) {
				if (Date.now() >= deadline || stopped()) break;
				await progress(`Testing the form on ${pathOf(url)}`);
				const { page, log } = await browser.openPage(primary);
				browser.setActivePage(page);
				try {
					await browser.goto(page, url, log);
					const result = await testForms(page, { url, viewport: primary.name, browser, blocked: () => blocked.writes, reload: () => browser.goto(page, url, log, { quietMs: 800 }).catch(() => {}), save });
					addCandidates(result.candidates);
					state.coverage.forms += result.tested;
					if (result.inventory.some(form => form.role === 'login')) state.coverage.loginForm = true;
				} catch (error) {
					limitation('forms', `Form testing on ${url} stopped early: ${String(error.message).split('\n')[0].slice(0, 160)}`);
				} finally { await page.close().catch(() => {}); }
			}
			return `${state.coverage.forms} forms tested`;
		}, added => state.coverage.forms ? `I tested ${plural(state.coverage.forms, 'form')} with empty and invalid input (nothing was submitted): ${describeCandidates(added)}.` : 'There were no forms to test.');

		// 6. Security
		await phase('security', async deadline => {
			await progress('Checking headers, cookies and exposed files');
			addCandidates(await auditOrigin({ targetUrl: session.targetUrl, mainResponse, cookies, fetchImpl, deadline }));
			state.coverage.securityChecks += 24; // headers, cookies, CORS, transport, 13 exposed-file probes, security.txt
			const list = pageList();
			const injectionTargets = [...new Set([session.targetUrl, ...list.filter(url => new URL(url).search || /search|find|query|result|product|item|login|signin|account/i.test(url)), ...list.filter(url => (pages.get(url)?.forms ?? 0) > 0)])].slice(0, 6);
			for (const url of injectionTargets) {
				if (Date.now() >= deadline || stopped()) break;
				await progress(`Probing ${pathOf(url)} for injection`);
				addCandidates(await probeInjection({ browser, profile: primary, url, params: pages.get(url)?.params ?? [], fetchImpl, deadline }));
				state.coverage.injectionUrls++;
				state.coverage.securityChecks += 4; // reflected XSS, script-context XSS, DOM XSS, SQL error
			}
			const authRoutes = await discoverAuthRoutes(new URL(session.targetUrl).origin, { fetchImpl }).catch(() => []);
			const redirectTargets = [...new Set([session.targetUrl, ...list.filter(url => /login|signin|sign-in|auth|logout|redirect|account/i.test(url)), ...authRoutes])].slice(0, 5);
			addCandidates(await probeRedirects({ urls: redirectTargets, fetchImpl, deadline }));
			state.coverage.securityChecks += redirectTargets.length;
			return `${state.coverage.injectionUrls} URLs probed`;
		}, added => `I ran ${state.coverage.securityChecks} non-destructive security checks (headers, cookies, CORS, exposed files, client-side secrets, and XSS, SQL-error and open-redirect probes on ${plural(state.coverage.injectionUrls, 'URL')}): ${describeCandidates(added)}.`);

		// 7. Links
		await phase('links', async deadline => {
			await progress(`Checking ${plural(links.size, 'link')}`);
			const result = await checkLinks({ links, origin: new URL(session.targetUrl).origin, fetchImpl, deadline });
			addCandidates(result.candidates);
			state.coverage.linksChecked = result.checked;
			return `${result.checked} links checked`;
		}, added => `I checked ${plural(state.coverage.linksChecked, 'link')}: ${added.length ? describeCandidates(added) : 'none are broken'}.`);

		// 8. Exploration
		let exploreSummary;
		await phase('explore', async deadline => {
			if (!models.reasonerAvailable()) {
				limitation('explore', models.state.reasoner.enabled ? `AI exploratory testing was unavailable (reasoning model error: ${models.state.reasoner.lastError ?? 'unknown'}).` : 'AI exploratory testing was skipped: no reasoning-model key is configured (QASE_API_KEY / QASE_REASONER_API_KEY).');
				return 'skipped (no reasoner)';
			}
			const known = state.candidates.map(item => item.title).slice(0, 40);
			const result = await explore({ browser, profile: primary, startUrl: state.signedInUrl ?? session.targetUrl, models, knownIssues: known, maxSteps: options.exploreSteps, deadline, signal,
				blockedWrites: () => blocked.writes, save, signedIn: Boolean(state.signedIn), pages: pageList().map(pathOf),
				focus: session.testCaseSnapshot?.title ?? session.messages?.find(message => message.role === 'user')?.text?.slice(0, 500),
				onStep: step => { state.coverage.exploration = (state.coverage.exploration ?? 0) + 1; void progress(`AI tester: ${step.name}${step.args?.url ? ` ${pathOf(step.args.url)}` : ''} on ${pathOf(step.url)}`); } });
			addCandidates(result.candidates);
			state.coverage.explorationSummary = result.summary.summary;
			exploreSummary = result.summary.summary;
			if (!result.summary.steps) limitation('explore', `AI exploratory testing was unavailable (reasoning model error: ${models.state.reasoner.lastError ?? 'no response'}).`);
			else if (!result.summary.finished && Date.now() >= deadline) limitation('explore', `AI exploratory testing stopped after ${result.summary.steps} steps when its time slice ended.`);
			return `${result.summary.steps} steps, ${result.candidates.length} issues reported`;
		}, added => `The reasoning model explored the site like a user (${plural(state.coverage.exploration ?? 0, 'step')})${exploreSummary ? `: ${exploreSummary.slice(0, 400)}` : '.'} It reported ${describeCandidates(added)}.`);

		// 9. Visual review
		await phase('visual', async deadline => {
			if (!models.visionAvailable()) {
				if (models.state.reasoner.enabled) limitation('visual', `AI visual review was unavailable (reasoning model error: ${models.state.reasoner.lastError ?? 'budget reached'}).`);
				return models.state.reasoner.enabled ? 'skipped (reasoning model unavailable)' : 'skipped (no reasoning model configured)';
			}
			await progress(`Reviewing ${plural(shots.length, 'screenshot')} and ${plural(filmstrips.length, 'animation filmstrip')}`);
			const result = await reviewVisuals({ models, shots, filmstrips, save, signal, deadline, maxCalls: options.visualShots + 4, known: state.candidates.map(item => item.title) });
			addCandidates(result.candidates);
			state.coverage.visualReviews = result.calls;
			if (!result.calls && models.state.reasoner.lastError) limitation('visual', `AI visual review was unavailable (reasoning model error: ${models.state.reasoner.lastError}).`);
			return `${result.calls} reviews, ${result.candidates.length} issues`;
		}, added => `The reasoning model reviewed ${plural(state.coverage.visualReviews, 'screenshot set')} (pages at each viewport and animation filmstrips): ${describeCandidates(added)}.`);
	} catch (error) {
		if (error?.policyBlocked) {
			limitation('open', error.message, true);
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

	// 10–11. Triage and publish always run, even after a stop or failure.
	let result;
	if (stopped()) limitation(state.phase, 'Stopped by the user before every phase finished; the report covers the work completed until then.', true);
	for (const [id] of PHASES) if ((!state.phases[id] || state.phases[id].status === 'pending' || state.phases[id].status === 'running') && !['triage', 'publish'].includes(id)) state.phases[id] = { status: 'skipped', detail: stopped() ? 'Stopped by user' : 'Not reached' };
	if (stopped() && session.status === 'awaiting_input') await runStore.setStatus(session, 'running', 'Publishing the results');
	const triageSignal = undefined; // triage must not be cancelled by the stop that ended testing
	state.phase = 'triage';
	state.phases.triage = { status: 'running' };
	await syncTodos();
	const triageActivity = randomUUID();
	try { await runStore.addActivity(session, { id: triageActivity, type: 'tool', toolName: 'qa_triage', status: 'running', label: PHASES.find(([key]) => key === 'triage')[1] }); } catch { /* best effort */ }
	const blockedContext = blocked.writes || blocked.offsite ? `${blocked.writes} write requests and ${blocked.offsite} off-site navigations were blocked during testing (e.g. ${blocked.samples.slice(0, 3).map(item => `${item.method} ${pathOf(item.url)}`).join(', ')}).` : 'No requests were blocked.';
	try {
		result = await triage({ candidates: state.candidates, models, context: { target: session.targetUrl, pages: state.coverage.pages, viewports: state.coverage.viewports, blocked: blockedContext }, signal: triageSignal, deadline: Date.now() + 4 * 60_000 });
		state.phases.triage = { status: 'done', detail: `${result.findings.length} confirmed of ${result.stats.merged}` };
	} catch (error) {
		console.warn('[qa-engine] triage failed, using deterministic confidence:', error);
		result = { findings: state.candidates.filter(item => item.source === 'detector' && item.confidence >= 0.7), dismissed: [], stats: { candidates: state.candidates.length, verifiedBy: [], unverified: state.candidates.length } };
		state.phases.triage = { status: 'failed', detail: 'Verification failed; deterministic confidence used' };
		limitation('triage', 'Model verification failed; findings were selected by detector confidence only.');
	}
	try { await runStore.updateActivity(session, triageActivity, { status: 'done', summary: state.phases.triage.detail }); } catch { /* best effort */ }
	if (!result.stats.verifiedBy?.length && result.stats.merged) limitation('triage', `Neither JEV nor the reasoning model was available to verify candidates (${models.state.jev.lastError ?? models.state.reasoner.lastError ?? 'no model keys configured'}); findings come from high-confidence automated checks only.`);
	if (state.coverage.loginForm && !state.signedIn) limitation('signin', state.credentialsDeclined ? 'The site has a sign-in form; no test account was given, so pages behind sign-in were not tested.' : 'The site has a sign-in form, but no test account was provided, so pages behind sign-in were not tested. Add a test account to include them.', true);
	if (blocked.writes && !state.allowWrites) limitation('forms', `QASE blocked ${blocked.writes} write request${blocked.writes === 1 ? '' : 's'} during interaction so no data was changed; server-side handling of submitted data was not tested.`);
	const verifier = result.stats.verifiedBy?.includes('jev') ? 'JEV' : result.stats.verifiedBy?.includes('reasoner') ? 'The reasoning model' : '';
	await say(verifier
		? `${verifier} checked ${plural(result.stats.merged ?? 0, 'possible issue')} (duplicates across pages and viewports merged): **${result.findings.length} confirmed**, ${result.dismissed.length} dismissed as false positives or test-harness side effects.`
		: `I grouped ${plural(result.stats.merged ?? 0, 'possible issue')} and kept the ${result.findings.length} backed by high-confidence automated checks (no model was available to verify the rest).`, { id: `qa-step-triage-${state.startedAt}` });

	state.phase = 'publish';
	state.phases.publish = { status: 'running' };
	await syncTodos();
	try {
		const refined = await refineWithReasoner({ models, target: session.targetUrl, findings: result.findings, coverage: state.coverage, limitations: state.limitations, signal: AbortSignal.timeout(150_000) }).catch(() => ({}));
		const published = [];
		for (const [index, item] of result.findings.entries()) {
			const fix = refined.fixes?.get(index) ?? item.fix ?? DEFAULT_FIX[item.category] ?? DEFAULT_FIX.functional;
			const finding = redact(session.id, {
				id: randomUUID(), ts: Date.now(), title: item.title, severity: item.severity, category: item.category, url: item.url,
				steps: item.steps, expected: item.expected || 'The page behaves correctly.', actual: item.actual,
				evidence: [item.evidence, item.viewports?.length ? `Reproduced at: ${item.viewports.join(', ')}` : '', item.urls?.length > 1 ? `Also on: ${item.urls.slice(1, 6).join(', ')}` : '', item.verification ? `Verified by ${item.verification.by === 'jev' ? 'JEV' : 'the reasoning model'} (${Math.round(item.verification.probability * 100)}% genuine)` : 'Verified by deterministic check'].filter(Boolean).join('\n'),
				engine: session.engine, status: 'open', statusTs: Date.now(), statusNote: '',
				selector: item.selector, viewports: item.viewports, fix, artifactId: item.artifactId, source: item.source, detector: item.detector, score: item.score
			});
			state.findingDetails[finding.id] = { selector: finding.selector, viewports: finding.viewports, fix: finding.fix, artifactId: finding.artifactId, source: finding.source, detector: finding.detector, score: finding.score };
			session.findings = [...(session.findings ?? []), finding];
			published.push(finding);
			try { await runStore.commit(session, 'finding', { finding }); } catch (error) { console.warn('[qa-engine] finding commit failed:', error?.message); }
		}
		const report = redact(session.id, buildReport({ session, findings: published, dismissed: result.dismissed, coverage: state.coverage, limitations: state.limitations, models, triageStats: result.stats, loaded, refined,
			runtime: { engine: session.runtimeFacts?.launchedEngineId, version: session.runtimeFacts?.browserVersion } }));
		session.report = report;
		state.status = 'done';
		state.phases.publish = { status: 'done', detail: `${published.length} findings, verdict ${report.verdict}` };
		await syncTodos();
		await persist({ checkpoint: true });
		await runStore.commit(session, 'report', { report });
		await flushUsage();
		// Findings as cards in the conversation (most severe first), then the report card.
		const ordered = [...published].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
		for (const finding of ordered.slice(0, 15)) await say(`**${finding.severity.toUpperCase()}** · ${finding.title}`, { kind: 'qa-finding', id: `qaf-${finding.id}` });
		if (ordered.length > 15) await say(`…and ${plural(ordered.length - 15, 'more finding')} in the Findings tab and the report.`, { id: `qa-more-${report.ts}` });
		await say(`${report.summary}`, { kind: 'qa-report', id: `qa-report-${report.ts}` });
		await runStore.setStatus(session, 'done');
	} catch (error) {
		console.error('[qa-engine] publish failed:', error);
		state.status = 'error';
		await persist({ checkpoint: true });
		await runStore.setStatus(session, 'error', `The report could not be saved: ${String(error?.message ?? error).slice(0, 200)}`);
	}
}
