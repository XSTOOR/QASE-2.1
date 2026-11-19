/**
 * QASE QA engine (v2).
 *
 * A host-orchestrated pipeline. Deterministic detectors do the measuring; the
 * reasoning model explores and reviews visuals; JEV verifies and grades.
 *
 *   1. open      load the target, capture headers/cookies, start live view
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
 * Completion guarantee: each phase runs inside its own try/catch with its own
 * time slice of the run budget. A failing phase becomes a recorded limitation,
 * never a terminal state. A user stop or any unexpected error still publishes a
 * partial report. Phase progress is checkpointed so a process restart resumes
 * after the last completed phase.
 */
import { randomUUID } from 'node:crypto';
import { createArtifactStore } from '../artifactStore.js';
import { redact } from '../secrets.js';
import { createQaBrowser, primaryProfile, VIEWPORTS } from './browser.js';
import { createQaModels, qaModelSettings } from './models.js';
import { candidate } from './findings.js';
import { auditPage } from './detectors/page.js';
import { testInteractions, testHoverMenus, testReducedMotion } from './detectors/interactions.js';
import { testForms } from './detectors/forms.js';
import { auditOrigin, auditPageSecurity, probeInjection, probeRedirects, discoverAuthRoutes } from './detectors/security.js';
import { createFrontier, checkLinks, normalizeUrl } from './crawl.js';
import { explore } from './explorer.js';
import { reviewVisuals } from './visualReview.js';
import { triage } from './triage.js';
import { signIn } from './signin.js';
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

// Fraction of the run budget by which each phase must have finished.
const PHASE_END = { open: 0.06, signin: 0.09, crawl: 0.32, viewports: 0.42, motion: 0.56, forms: 0.62, security: 0.7, links: 0.74, explore: 0.86, visual: 0.92, triage: 0.97, publish: 1 };

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
		maxArtifacts: positive(env.QASE_QA_MAX_ARTIFACTS, 120, 500)
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
	const phaseDeadline = phase => started + budgetMs * PHASE_END[phase];
	let artifacts = 0;

	const persist = async () => {
		state.updatedAt = Date.now();
		state.elapsedMs = elapsedBefore + (Date.now() - started);
		try { await runStore.commit(session, 'hybrid.state', { hybrid: publicQaState(session) }); }
		catch (error) { console.warn('[qa-engine] checkpoint failed:', error?.message); }
	};
	const say = async (text, kind) => {
		try { await runStore.addMessage(session, { role: kind ? 'system' : 'assistant', text, ...(kind ? { kind } : {}) }); } catch { /* best effort */ }
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

	async function phase(id, work) {
		if (['done', 'skipped'].includes(state.phases[id]?.status)) return;
		if (stopped()) { state.phases[id] = { status: 'skipped', detail: 'Stopped by user' }; return; }
		state.phase = id;
		state.phases[id] = { status: 'running', startedAt: Date.now() };
		await syncTodos();
		await persist();
		const activityId = randomUUID();
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
		try { await runStore.updateActivity(session, activityId, { status: state.phases[id].status === 'failed' ? 'error' : 'done', summary: state.phases[id].detail ?? state.phases[id].status }); } catch { /* best effort */ }
		await flushUsage();
		await syncTodos();
		await persist();
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
		if (!state.phases.open) await say(`Testing ${session.targetUrl} in ${browser.engine} ${browser.version}. I'll crawl the site, test layout, animations, forms, accessibility and security, explore key journeys with the reasoning model, then verify every candidate with JEV before reporting.`);

		const open = async url => {
			const { page, log } = await browser.openPage(primary);
			await browser.goto(page, url, log);
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
					await page.close();
					loaded = Boolean(mainResponse) && mainResponse.status < 500;
					break;
				} catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); }
			}
			state.loaded = loaded;
			if (!loaded) throw new Error(lastError ? `The site could not be loaded: ${String(lastError.message).split('\n')[0]}` : `The site responded with HTTP ${mainResponse?.status}.`);
			state.mainResponse = { status: mainResponse.status, headers: mainResponse.headers };
			return `HTTP ${mainResponse.status}`;
		});
		mainResponse ??= state.mainResponse;
		if (!loaded) throw Object.assign(new Error('target_unreachable'), { expected: true });

		// 1b. Optional sign-in. Re-done on resume because browser state is not persisted.
		if (session.qaAuth?.authorized) {
			if (state.phases.signin?.status === 'done') state.phases.signin = undefined;
			await phase('signin', async () => {
				const authRoutes = await discoverAuthRoutes(new URL(session.targetUrl).origin, { fetchImpl }).catch(() => []);
				const outcome = await signIn({ browser, profile: primary, session, candidates: [session.targetUrl, ...authRoutes.filter(url => !/logout|redirect|out$/.test(url))] });
				state.signedIn = outcome.ok;
				if (!outcome.ok) {
					limitation('signin', `Signed-in areas were not tested. ${outcome.reason} Public pages were tested instead.`, true);
					return 'public only';
				}
				await say('Signed in with the test account. Testing continues with the signed-in session (read-only).');
				return 'signed in';
			});
		} else {
			state.phases.signin = { status: 'skipped', detail: 'No test account provided' };
		}

		// 2. Crawl + primary audit
		await phase('crawl', async deadline => {
			// An interrupted crawl restarts from the target; merged fingerprints absorb repeats.
			state.visited = [];
			pages.clear();
			const frontier = createFrontier({ start: session.targetUrl, inScope: browser.inScope, maxPages: options.maxPages });
			let url;
			while ((url = frontier.next()) && pages.size < options.maxPages && Date.now() < deadline && !stopped()) {
				if (state.visited.includes(url)) continue;
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
					if (finalUrl !== url && state.visited.includes(finalUrl)) { await page.close(); state.visited.push(url); continue; }
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
					pages.set(finalUrl, { title: result.metrics?.title, forms: result.metrics?.forms ?? 0, controls: result.metrics?.controls ?? 0, params: [...new URL(finalUrl).searchParams.keys()] });
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
			if (frontier.size > pages.size && pages.size >= options.maxPages) limitation('crawl', `Crawled the first ${pages.size} pages (limit QASE_QA_MAX_PAGES=${options.maxPages}); ${frontier.size - pages.size} more discovered pages were not audited.`);
			return `${pages.size} pages audited`;
		});
		const pageList = [...pages.keys()];
		const keyPages = pageList.slice(0, options.secondaryPages);

		// 3. Secondary viewports
		await phase('viewports', async deadline => {
			for (const profile of secondary) {
				for (const url of keyPages) {
					if (Date.now() >= deadline || stopped()) break;
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
		});

		// 4. Motion and interactions
		await phase('motion', async deadline => {
			const profiles = [primary, ...secondary.filter(profile => profile.isMobile).slice(0, 1)];
			for (const profile of profiles) {
				for (const url of pageList.slice(0, options.interactionPages)) {
					if (Date.now() >= deadline || stopped()) break;
					const { page, log } = await browser.openPage(profile);
					try {
						await browser.goto(page, url, log);
						const reload = async () => { await browser.goto(page, url, log).catch(() => {}); };
						const result = await testInteractions(page, { url, viewport: profile.name, browser, reload, save, limit: options.triggersPerPage, deadline });
						addCandidates(result.candidates);
						state.coverage.interactions += result.tested;
						filmstrips.push(...result.filmstrips);
						if (!profile.isMobile) {
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
					await browser.goto(page, session.targetUrl, log);
					await page.waitForTimeout(600);
					addCandidates(await testReducedMotion(page, { url: session.targetUrl, viewport: primary.name }));
				} catch { /* optional check */ } finally { await page.close().catch(() => {}); }
			}
			filmstrips = filmstrips.slice(0, 8);
			return `${state.coverage.interactions} controls tested`;
		});

		// 5. Forms
		await phase('forms', async deadline => {
			for (const url of pageList.filter(url => (pages.get(url)?.forms ?? 0) > 0).slice(0, 6)) {
				if (Date.now() >= deadline || stopped()) break;
				const { page, log } = await browser.openPage(primary);
				try {
					await browser.goto(page, url, log);
					const result = await testForms(page, { url, viewport: primary.name, browser, blocked: () => blocked.writes, reload: () => browser.goto(page, url, log).catch(() => {}), save });
					addCandidates(result.candidates);
					state.coverage.forms += result.tested;
					if (result.inventory.some(form => form.role === 'login')) state.coverage.loginForm = true;
				} catch (error) {
					limitation('forms', `Form testing on ${url} stopped early: ${String(error.message).split('\n')[0].slice(0, 160)}`);
				} finally { await page.close().catch(() => {}); }
			}
			return `${state.coverage.forms} forms tested`;
		});

		// 6. Security
		await phase('security', async deadline => {
			addCandidates(await auditOrigin({ targetUrl: session.targetUrl, mainResponse, cookies, fetchImpl, deadline }));
			state.coverage.securityChecks += 24; // headers, cookies, CORS, transport, 13 exposed-file probes, security.txt
			const injectionTargets = [...new Set([session.targetUrl, ...pageList.filter(url => new URL(url).search || /search|find|query|result|product|item|login|signin|account/i.test(url))])].slice(0, 5);
			for (const url of injectionTargets) {
				if (Date.now() >= deadline || stopped()) break;
				addCandidates(await probeInjection({ browser, profile: primary, url, params: pages.get(url)?.params ?? [], fetchImpl, deadline }));
				state.coverage.injectionUrls++;
				state.coverage.securityChecks += 4; // reflected XSS, script-context XSS, DOM XSS, SQL error
			}
			const authRoutes = await discoverAuthRoutes(new URL(session.targetUrl).origin, { fetchImpl }).catch(() => []);
			const redirectTargets = [...new Set([session.targetUrl, ...pageList.filter(url => /login|signin|sign-in|auth|logout|redirect|account/i.test(url)), ...authRoutes])].slice(0, 5);
			addCandidates(await probeRedirects({ urls: redirectTargets, fetchImpl, deadline }));
			state.coverage.securityChecks += redirectTargets.length;
			return `${state.coverage.injectionUrls} URLs probed`;
		});

		// 7. Links
		await phase('links', async deadline => {
			const result = await checkLinks({ links, origin: new URL(session.targetUrl).origin, fetchImpl, deadline });
			addCandidates(result.candidates);
			state.coverage.linksChecked = result.checked;
			return `${result.checked} links checked`;
		});

		// 8. Exploration
		await phase('explore', async deadline => {
			if (!models.reasonerAvailable()) {
				limitation('explore', models.state.reasoner.enabled ? `AI exploratory testing was unavailable (reasoning model error: ${models.state.reasoner.lastError ?? 'unknown'}).` : 'AI exploratory testing was skipped: no reasoning-model key is configured (QASE_API_KEY / QASE_REASONER_API_KEY).');
				return 'skipped (no reasoner)';
			}
			const known = state.candidates.map(item => item.title).slice(0, 40);
			const result = await explore({ browser, profile: primary, startUrl: session.targetUrl, models, knownIssues: known, maxSteps: options.exploreSteps, deadline, signal,
				blockedWrites: () => blocked.writes, save, focus: session.testCaseSnapshot?.title ?? session.messages?.find(message => message.role === 'user')?.text?.slice(0, 500),
				onStep: () => { state.coverage.exploration = (state.coverage.exploration ?? 0) + 1; } });
			addCandidates(result.candidates);
			state.coverage.explorationSummary = result.summary.summary;
			if (!result.summary.steps) limitation('explore', `AI exploratory testing was unavailable (reasoning model error: ${models.state.reasoner.lastError ?? 'no response'}).`);
			else if (!result.summary.finished && Date.now() >= deadline) limitation('explore', `AI exploratory testing stopped after ${result.summary.steps} steps when its time slice ended.`);
			return `${result.summary.steps} steps, ${result.candidates.length} issues reported`;
		});

		// 9. Visual review
		await phase('visual', async deadline => {
			if (!models.visionAvailable()) {
				if (models.state.reasoner.enabled) limitation('visual', `AI visual review was unavailable (reasoning model error: ${models.state.reasoner.lastError ?? 'budget reached'}).`);
				return models.state.reasoner.enabled ? 'skipped (reasoning model unavailable)' : 'skipped (no reasoning model configured)';
			}
			const result = await reviewVisuals({ models, shots, filmstrips, save, signal, deadline, maxCalls: options.visualShots + 4, known: state.candidates.map(item => item.title) });
			addCandidates(result.candidates);
			state.coverage.visualReviews = result.calls;
			if (!result.calls && models.state.reasoner.lastError) limitation('visual', `AI visual review was unavailable (reasoning model error: ${models.state.reasoner.lastError}).`);
			return `${result.calls} reviews, ${result.candidates.length} issues`;
		});
	} catch (error) {
		if (error?.policyBlocked) {
			limitation('open', error.message, true);
		} else if (!error?.expected && !stopped()) {
			console.error('[qa-engine] unexpected failure; publishing what was collected:', error);
			limitation(state.phase, `The run hit an unexpected error during "${state.phase}" and published the results collected so far: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}`, true);
		}
	} finally {
		await browser?.close().catch(() => {});
	}

	// 10–11. Triage and publish always run, even after a stop or failure.
	let result;
	if (stopped()) limitation(state.phase, 'Stopped by the user before every phase finished; the report covers the work completed until then.', true);
	for (const [id] of PHASES) if (!state.phases[id] && !['triage', 'publish'].includes(id)) state.phases[id] = { status: 'skipped', detail: stopped() ? 'Stopped by user' : 'Not reached' };
	const triageSignal = undefined; // triage must not be cancelled by the stop that ended testing
	state.phase = 'triage';
	state.phases.triage = { status: 'running' };
	await syncTodos();
	try {
		result = await triage({ candidates: state.candidates, models, context: { target: session.targetUrl, pages: state.coverage.pages, viewports: state.coverage.viewports }, signal: triageSignal, deadline: Date.now() + 4 * 60_000 });
		state.phases.triage = { status: 'done', detail: `${result.findings.length} confirmed of ${result.stats.merged}` };
	} catch (error) {
		console.warn('[qa-engine] triage failed, using deterministic confidence:', error);
		result = { findings: state.candidates.filter(item => item.source === 'detector' && item.confidence >= 0.7), dismissed: [], stats: { candidates: state.candidates.length, verifiedBy: [], unverified: state.candidates.length } };
		state.phases.triage = { status: 'failed', detail: 'Verification failed; deterministic confidence used' };
		limitation('triage', 'Model verification failed; findings were selected by detector confidence only.');
	}
	if (!result.stats.verifiedBy?.length && result.stats.merged) limitation('triage', `Neither JEV nor the reasoning model was available to verify candidates (${models.state.jev.lastError ?? models.state.reasoner.lastError ?? 'no model keys configured'}); findings come from high-confidence automated checks only.`);
	if (state.coverage.loginForm && !state.signedIn && !session.qaAuth?.authorized) limitation('signin', 'The site has a sign-in form, but no test account was provided, so pages behind sign-in were not tested. Add a test account when starting the run to include them.', true);
	if (blocked.writes && !state.allowWrites) limitation('forms', `QASE blocked ${blocked.writes} write request${blocked.writes === 1 ? '' : 's'} during interaction so no data was changed; server-side handling of submitted data was not tested.`);

	state.phase = 'publish';
	state.phases.publish = { status: 'running' };
	await syncTodos();
	try {
		const refined = await refineWithReasoner({ models, target: session.targetUrl, findings: result.findings, coverage: state.coverage }).catch(() => ({}));
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
		await persist();
		await runStore.commit(session, 'report', { report });
		await flushUsage();
		await say(`${report.summary}\n\nVerdict: **${report.verdict.replace(/_/g, ' ')}** — ${published.length} finding${published.length === 1 ? '' : 's'}. Fix prompts for every finding are ready in the Report tab.`);
		await runStore.setStatus(session, 'done');
	} catch (error) {
		console.error('[qa-engine] publish failed:', error);
		state.status = 'error';
		await persist();
		await runStore.setStatus(session, 'error', `The report could not be saved: ${String(error?.message ?? error).slice(0, 200)}`);
	}
}
