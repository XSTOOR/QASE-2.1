/**
 * QASE Founder review engine (v2).
 *
 * A business-perspective review of a product on the CleanSlate SDK, with the
 * reasoning model only (no JEV, no hybrid routing) — the same stage
 * architecture as compliance SQA. The host runs fixed stages; the SDK agent
 * does the thinking inside each one:
 *
 *   1. open        load the product and read its key pages
 *   2. brief       the owner's goals, customers, journeys and competitors;
 *                  asks one short question in the conversation when the
 *                  launcher left the goals and the customer blank
 *   3. signin      ask for / use a test account at a sign-in wall
 *   4. understand  agent: what the product is, for whom, how it makes money,
 *                  its main conversion goal and the journeys to walk
 *   5. market      agent: web research on competitors and category
 *                  expectations; every competitor must cite a found source
 *   6. measure     host: first screen on desktop and phone, trust, pricing,
 *                  sign-up friction, polish, speed, errors, links, SEO, hooks
 *   7. journeys    agent: walks each journey as the target customer
 *   8. evaluate    agent: scores ten business lenses with cited evidence
 *   9. recommend   agent: what to do, what to avoid, what to keep
 *  10. report      host: readiness score, verdict and order; agent: summary
 *
 * Completion guarantee: every stage has a deadline and a fallback (measured
 * lens scores and recommendations written from the measured signals), so a
 * run always ends with a report even when the model or the internet is
 * unavailable.
 */
import { randomUUID } from 'node:crypto';
import { createArtifactStore } from '../artifactStore.js';
import { redact } from '../secrets.js';
import { createQaBrowser, primaryProfile, VIEWPORTS } from '../qa/browser.js';
import { qaModelSettings } from '../qa/models.js';
import { normalizeUrl } from '../qa/crawl.js';
import { signIn, hasLoginForm } from '../qa/signin.js';
import { accountQuestion, waitForAccount } from '../qa/accountQuestion.js';
import { applyUsage } from '../usageCapture.js';
import { createStageAgent, stageModelSettings } from '../stageAgent.js';
import { browsingTools } from '../sqa/tools.js';
import { heuristicProduct } from '../sqa/engine.js';
import { collectSignals } from './signals.js';
import { LENSES, LENS_IDS, PRODUCT_CATEGORIES } from './catalog.js';
import { recordBusinessTool, recordMarketTool, recordJourneyTool, scoreLensTool, recordRecommendationsTool, finishTool } from './tools.js';
import { buildFounderReport, founderFindings, fallbackRecommendations } from './report.js';

export const FOUNDER_ENGINE_VERSION = 2;
export { MAX_FOUNDER_STATE_BYTES } from './state.js';

export const STAGES = [
	['open', 'Open the product and read its key pages'],
	['brief', 'Confirm your goals and who the product is for'],
	['signin', 'Sign in with a test account (when needed)'],
	['understand', 'Understand the product and its business model'],
	['market', 'Research competitors and what users expect'],
	['measure', 'Measure first impression, trust, conversion and speed'],
	['journeys', 'Walk the key journeys as a new customer'],
	['evaluate', 'Score the product on ten business areas'],
	['recommend', 'Decide what to do, what to avoid and what to keep'],
	['report', 'Publish the review']
];
const SHARE = { open: 6, brief: 2, signin: 3, understand: 7, market: 16, measure: 12, journeys: 30, evaluate: 9, recommend: 10, report: 5 };
const STAGE_IDS = STAGES.map(([id]) => id);
const KEY_PAGE = /pricing|plans|features|product|how it works|solutions|about|customers|testimonials|reviews|case stud|sign ?up|get started|register|demo|faq|help|contact|blog|integrations|security/i;
const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const pathOf = url => { try { const parsed = new URL(url); return parsed.pathname || '/'; } catch { return url; } };
const positive = (value, fallback, max) => { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.min(max, Math.floor(number)) : fallback; };
const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || undefined;
const lines = (value, max = 6, length = 200) => (Array.isArray(value) ? value : String(value ?? '').split(/\n|;/)).map(item => clean(item, length)).filter(Boolean).slice(0, max);

export function isFounderEngineSession(session) {
	return session?.mode === 'founder' && session.founder?.version === FOUNDER_ENGINE_VERSION;
}

/** The owner's steering, from the launcher (all optional). */
export function normalizeBrief(input = {}) {
	return {
		goals: clean(input.goals, 1500), audience: clean(input.audience, 600), stage: ['idea', 'pre_launch', 'early', 'growth'].includes(input.stage) ? input.stage : undefined,
		journeys: lines(input.journeys, 4, 160), competitors: lines(input.competitors, 6, 300),
		focus: (Array.isArray(input.focus) ? input.focus : []).filter(id => LENS_IDS.includes(id)).slice(0, LENS_IDS.length)
	};
}

/** State created at launch. */
export function createFounderRunState({ targetUrl, name, brief } = {}) {
	const normalized = normalizeBrief(brief);
	return {
		version: FOUNDER_ENGINE_VERSION, engine: 'qase-founder', status: 'pending', startedAt: Date.now(), updatedAt: Date.now(),
		// projectStateFromSession (Studio handoff) reads the target and the owner's goals from scope.
		scope: { target: { url: targetUrl, name: name || (() => { try { return new URL(targetUrl).host; } catch { return 'Product'; } })() }, productContext: normalized },
		brief: normalized, phase: 'open', phases: {}, pages: [], visited: [], business: undefined, journeyPlan: [], journeys: [], market: undefined,
		signals: [], screenshots: [], lenses: {}, recommendations: [], keep: [], sources: [], limitations: [], coverage: { pages: 0, searches: 0, fetches: 0 }, models: {}, summary: undefined
	};
}

export function engineOptions(env = process.env) {
	return {
		budgetMs: positive(env.QASE_FOUNDER_MAX_MINUTES, 30, 120) * 60_000,
		keyPages: positive(env.QASE_FOUNDER_KEY_PAGES, 8, 20),
		credentialWaitMs: positive(env.QASE_QA_CREDENTIAL_WAIT_MINUTES, 10, 120) * 60_000,
		briefWaitMs: positive(env.QASE_FOUNDER_BRIEF_WAIT_MINUTES, 5, 60) * 60_000,
		askForCredentials: env.QASE_QA_ASK_CREDENTIALS !== 'false',
		askForBrief: env.QASE_FOUNDER_ASK_BRIEF !== 'false'
	};
}

/** The one question asked when the launcher left goals and customer blank. */
export function briefQuestion(host) {
	return {
		kind: 'founder_brief', options: ['Skip — work it out from the site'], allowCustom: true,
		question: `Before I review ${host}: what should it achieve, and who is it for?`,
		summary: 'One or two lines is enough, for example "Get small agencies to start a free trial; they compare us with Asana and Trello". Mention any journey you want me to test. Reply skip and I\'ll work it out from the site.'
	};
}

/** Waits for the owner's reply to a free-text question (record.founderReply). */
async function waitForReply({ session, runStore, record, signal, waitMs, question }) {
	session.pendingQuestion = question;
	try { await runStore.commit(session, 'question', { question }); } catch { /* best effort */ }
	await runStore.setStatus(session, 'awaiting_input', 'Waiting for your answer');
	const started = Date.now();
	const answer = await new Promise(resolve => {
		const done = value => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); if (record) record.founderReply = undefined; resolve(value); };
		const timer = setTimeout(() => done({ timeout: true }), waitMs);
		timer.unref?.();
		const onAbort = () => done({ stopped: true });
		if (signal?.aborted) return done({ stopped: true });
		signal?.addEventListener('abort', onAbort, { once: true });
		if (record) record.founderReply = done;
	});
	session.pendingQuestion = undefined;
	try { await runStore.commit(session, 'question', { question: null }); } catch { /* best effort */ }
	if (!answer.stopped) await runStore.setStatus(session, 'running', 'Reviewing the product');
	return { answer, waitedMs: Date.now() - started };
}

/** Runs (or resumes) one Founder review to completion. */
export async function runFounderEngine({ session, runStore, record, signal, env = process.env, settings = qaModelSettings(env), artifactStore = createArtifactStore(), fetchImpl: probeFetch = fetch, rootDir }) {
	if (session.founder?.report && session.founder.finalizedAt) {
		await runStore.addMessage(session, { role: 'agent', kind: 'qa-step', text: 'This review is complete. Start a new Founder review to review the product again.' });
		return;
	}
	if (!session.targetUrl) {
		await runStore.setStatus(session, 'awaiting_input', 'Waiting for a product URL.');
		return;
	}
	const options = engineOptions(env);
	if (session.founder?.version !== FOUNDER_ENGINE_VERSION) session.founder = createFounderRunState({ targetUrl: session.targetUrl });
	const state = session.founder;
	state.targetUrl = session.targetUrl;
	state.status = 'running';
	const started = Date.now();
	let pausedMs = 0;
	const budgetEnd = () => started + options.budgetMs - (state.elapsedMs ?? 0) + pausedMs;
	const stageDeadline = id => {
		const remaining = Math.max(30_000, budgetEnd() - Date.now());
		const pending = STAGE_IDS.slice(STAGE_IDS.indexOf(id)).filter(stage => stage === id || !['done', 'skipped', 'failed'].includes(state.phases[stage]?.status));
		return Date.now() + remaining * SHARE[id] / pending.reduce((sum, stage) => sum + SHARE[stage], 0);
	};
	const host = (() => { try { return new URL(session.targetUrl).host; } catch { return session.targetUrl; } })();
	const stopped = () => signal?.aborted;
	const limitation = (phase, message) => { if (!state.limitations.some(item => item.message === message)) state.limitations.push({ phase, message: String(message).slice(0, 500) }); };
	const persist = async ({ checkpoint = false } = {}) => {
		state.updatedAt = Date.now();
		try { await runStore.commit(session, 'founder.state', { founder: redact(session.id, state), ...(checkpoint ? { checkpoint: true } : {}) }); } catch (error) { console.warn('[founder-engine] checkpoint failed:', error?.message); }
	};
	const say = async (text, { kind = 'qa-step', id } = {}) => {
		if (id && session.messages?.some(message => message.id === id)) return;
		try { await runStore.addMessage(session, { ...(id ? { id } : {}), role: 'agent', kind, text: redact(session.id, text) }); } catch { /* best effort */ }
	};
	let currentActivity;
	let progressAt = 0;
	const progress = async detail => {
		if (!currentActivity || Date.now() - progressAt < 1000) return;
		progressAt = Date.now();
		try { await runStore.updateActivity(session, currentActivity, { detail: String(detail).slice(0, 160) }); } catch { /* best effort */ }
	};
	const syncTodos = async () => {
		session.todos = STAGES.map(([id, label]) => ({ id, text: label, status: ['done', 'skipped', 'failed'].includes(state.phases[id]?.status) ? 'completed' : state.phases[id]?.status === 'running' ? 'in_progress' : 'pending' }));
		try { await runStore.commit(session, 'todos', { todos: session.todos }); } catch { /* best effort */ }
	};
	const save = async (bytes, label) => {
		if (!bytes) return undefined;
		try { return artifactStore.save(session, { type: 'screenshot', fileName: 'evidence.jpg', bytes, label: String(label).slice(0, 200) }).artifactId; } catch { return undefined; }
	};
	const flushUsage = async usage => {
		session.tokenUsage = applyUsage(session.tokenUsage, usage);
		try { await runStore.commit(session, 'usage', { usage: session.tokenUsage, mode: session.mode }); } catch { /* best effort */ }
	};

	async function stage(id, work) {
		if (['done', 'skipped'].includes(state.phases[id]?.status)) return;
		if (stopped()) { state.phases[id] = { status: 'skipped', detail: 'Stopped by user' }; return; }
		state.phase = id;
		const startedAt = Date.now();
		state.phases[id] = { status: 'running', startedAt };
		await syncTodos();
		await persist();
		currentActivity = randomUUID();
		const label = STAGES.find(([key]) => key === id)[1];
		try { await runStore.addActivity(session, { id: currentActivity, type: 'tool', toolName: `founder_${id}`, status: 'running', label }); } catch { /* best effort */ }
		const activity = currentActivity;
		try {
			const detail = await work(stageDeadline(id));
			state.phases[id] = { status: /^skipped/i.test(detail ?? '') ? 'skipped' : 'done', detail, startedAt, endedAt: Date.now() };
		} catch (error) {
			if (stopped()) state.phases[id] = { status: 'skipped', detail: 'Stopped by user', startedAt, endedAt: Date.now() };
			else {
				const message = String(error?.message ?? error).split('\n')[0].slice(0, 300);
				console.warn(`[founder-engine] stage ${id} failed:`, error);
				state.phases[id] = { status: 'failed', detail: message, startedAt, endedAt: Date.now() };
				limitation(id, `${label} did not complete: ${message}`);
				await say(`I couldn't finish this step (${label.toLowerCase()}): ${message}. I'm carrying on; the review lists what was missed.`);
			}
		}
		currentActivity = undefined;
		try { await runStore.updateActivity(session, activity, { status: state.phases[id].status === 'failed' ? 'error' : 'done', summary: state.phases[id].detail ?? state.phases[id].status, detail: '' }); } catch { /* best effort */ }
		await syncTodos();
		await persist({ checkpoint: true });
	}

	const model = stageModelSettings(settings, env, 'FOUNDER');
	state.models = { reasoner: { model: model.model, enabled: model.enabled, calls: state.models?.reasoner?.calls ?? 0 } };
	let browser, browse, agent;
	let fetchImpl = probeFetch;
	const primary = primaryProfile(session);
	const pageDossier = [];

	try {
		await runStore.setStatus(session, 'running', 'Reviewing the product');
		browser = await createQaBrowser({ session, allowWrites: false, env, publishFrame: frame => { try { runStore.publish?.(session, 'frame', { frame }); } catch { /* live view is best effort */ } } });
		if (record) record.bridge = { getLastFrame: () => browser?.getLastFrame(), stopFrames: () => browser?.stopFrames() };
		fetchImpl = browser.guardedFetch(probeFetch);
		if (!await browser.policyAllows(session.targetUrl, true)) throw Object.assign(new Error('The target is blocked by the browser safety policy (private or reserved network address).'), { policyBlocked: true });
		browser.startFrames();
		session.runtimeFacts = { ...(session.runtimeFacts ?? {}), launchedEngineId: browser.engine, browserVersion: browser.version, executionLevel: session.runtimeFacts?.executionLevel ?? 'SIMULATED', capturedAt: Date.now() };
		browse = browsingTools({ browser, profile: primary, prefix: 'founder', state: { targetUrl: session.targetUrl, visited: state.visited } });
		if (model.enabled) {
			agent = createStageAgent({
				session, model, rootDir,
				tools: [...browse.tools, recordBusinessTool(state), recordMarketTool(state), recordJourneyTool(state), scoreLensTool(state), recordRecommendationsTool(state), finishTool(state)],
				onUsage: usage => { state.models.reasoner.calls++; void flushUsage({ ...usage, model: model.model }); },
				onPart: part => { if (part.type === 'reasoning' || part.type === 'chat_text') void progress(String(part.content).replace(/\s+/g, ' ').slice(-150)); },
				onWebResult: (name, input, result) => {
					if (name === 'web_search') {
						state.coverage.searches++;
						for (const item of (result?.results ?? []).slice(0, 8)) if (item?.url && !state.sources.some(source => source.url === item.url) && state.sources.length < 80) state.sources.push({ url: item.url, title: String(item.title ?? '').slice(0, 200), via: 'search', query: String(input?.query ?? '').slice(0, 200) });
					} else if (name === 'web_fetch' && result?.success !== false) {
						state.coverage.fetches++;
						const url = result?.finalUrl ?? result?.url ?? input?.url;
						if (url && !state.sources.some(source => source.url === url) && state.sources.length < 80) state.sources.push({ url, title: String(result?.title ?? '').slice(0, 200), via: 'fetch' });
					}
				},
				onToolResult: async (name, input, result) => {
					const label = name === 'web_search' ? `Searched: "${String(input?.query ?? '').slice(0, 90)}"`
						: name === 'web_fetch' ? `Read: ${String(input?.url ?? '').replace(/^https?:\/\//, '').slice(0, 90)}`
							: name === 'founder_open' ? `Opened ${pathOf(input?.url)}`
								: name === 'founder_record_journey' ? `Journey ${input?.journey_id}: ${input?.outcome}`
									: name === 'founder_score_lens' ? `Scored ${input?.lens}: ${input?.score}/10`
										: name.replace(/^founder_/, '').replace(/_/g, ' ');
					await progress(label);
					if (['web_search', 'web_fetch', 'founder_open', 'founder_click', 'founder_type'].includes(name)) await runStore.addActivity(session, { type: 'tool', toolName: name, status: result?.success === false ? 'error' : 'done', label, summary: result?.success === false ? String(result.error ?? '').slice(0, 200) : undefined });
				}
			});
		} else {
			limitation('understand', 'No reasoning-model key is configured (QASE_API_KEY / QASE_REASONER_API_KEY), so the product was understood from keywords, no competitor research or journeys were done, and scores and advice come from the measured signals only.');
		}
		const browserName = browser.engine === 'chromium' ? `Chrome ${String(browser.version).split('.')[0]}` : `${browser.engine} ${browser.version}`;
		await say(`I'm reviewing **${host}** the way a founder, an investor and a first-time customer would, in ${browserName}. I'll work out what the product promises and to whom, look at the competition, measure the first impression, trust, conversion and speed, walk the key journeys as a new customer, score ten business areas, and finish with what to do, what to avoid and what to keep.`, { id: `founder-intro-${state.startedAt}` });

		// 1. Open and read the key pages.
		await stage('open', async deadline => {
			const { page, log } = await browser.openPage(primary);
			browser.setActivePage(page);
			try {
				await browser.goto(page, session.targetUrl, log);
				if (!log.mainResponse || log.mainResponse.status >= 500) throw new Error(`The site responded with HTTP ${log.mainResponse?.status ?? 'no response'}.`);
				state.mainStatus = log.mainResponse.status;
				state.loginWall = await hasLoginForm(page);
				const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => ({ href: a.href, text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 60) }))).catch(() => []);
				const candidates = [...new Map(links.map(link => [normalizeUrl(link.href, page.url()), link])).entries()].filter(([url]) => url && browser.inScope(url) && !/log ?out|sign ?out|\.(pdf|zip|png|jpe?g)$/i.test(url));
				const ranked = [...candidates.filter(([url, link]) => KEY_PAGE.test(`${url} ${link.text}`)), ...candidates.filter(([url, link]) => !KEY_PAGE.test(`${url} ${link.text}`))].map(([url]) => url);
				state.pages = [...new Set([normalizeUrl(page.url(), session.targetUrl) ?? session.targetUrl, ...ranked])].slice(0, options.keyPages);
			} finally { await page.close().catch(() => {}); }
			for (const url of state.pages) {
				if (Date.now() >= deadline || stopped()) break;
				await progress(`Reading ${pathOf(url)}`);
				const { page, log } = await browser.openPage(primary);
				browser.setActivePage(page);
				try {
					await browser.goto(page, url, log, { quietMs: 1200 });
					const read = await page.evaluate(() => ({ title: document.title, description: document.querySelector('meta[name=description]')?.content ?? '', text: (document.body?.innerText ?? '').replace(/\n{2,}/g, '\n').slice(0, 2500) })).catch(() => ({ title: '', text: '' }));
					pageDossier.push({ url, status: log.mainResponse?.status, ...read });
				} catch { /* unreadable page */ } finally { await page.close().catch(() => {}); }
			}
			state.coverage.pages = pageDossier.length;
			return `HTTP ${state.mainStatus}, ${plural(pageDossier.length, 'page')} read`;
		});
		if (!state.mainStatus) throw Object.assign(new Error('target_unreachable'), { expected: true });
		await say(`The site is up. I read ${plural(pageDossier.length, 'key page')}: ${pageDossier.slice(0, 8).map(page => `\`${pathOf(page.url)}\``).join(', ')}.${state.loginWall ? ' The start page is a sign-in screen.' : ''}`, { id: `founder-open-${state.startedAt}` });

		// 2. The owner's brief: ask once when the launcher left goals and customer blank.
		await stage('brief', async () => {
			const brief = state.brief;
			if (brief.goals || brief.audience) return 'from the launcher';
			if (!options.askForBrief || session.matrixRunId) return 'skipped (working it out from the site)';
			const { answer, waitedMs } = await waitForReply({ session, runStore, record, signal, waitMs: options.briefWaitMs, question: briefQuestion(host) });
			pausedMs += waitedMs;
			if (answer.text && !/^(skip|no|nope|later|not now|work it out)/i.test(answer.text.trim())) {
				brief.goals = clean(answer.text, 1500);
				brief.answeredInChat = true;
				state.scope.productContext = { ...brief };
				await say('Thanks — I\'ll review it against that.');
				return 'answered in the conversation';
			}
			return answer.timeout ? 'skipped (no answer; working it out from the site)' : 'skipped (working it out from the site)';
		});

		// 3. Sign-in when there is a wall (or an account was supplied).
		await stage('signin', async () => {
			if (!state.loginWall && !session.qaAuth?.authorized) return 'skipped (no sign-in wall)';
			if (!session.qaAuth?.authorized) {
				if (!options.askForCredentials || session.matrixRunId) return 'skipped (public pages only)';
				const { answer, waitedMs } = await waitForAccount({ session, runStore, record, signal, waitMs: options.credentialWaitMs, question: accountQuestion({ host, purpose: 'review' }), resumeDetail: 'Reviewing the product' });
				pausedMs += waitedMs;
				if (!answer.credentials) { limitation('signin', 'The signed-in product was not reviewed (no test account); onboarding after sign-up is judged from the public pages only.'); return 'skipped (public pages only)'; }
			}
			const outcome = await signIn({ browser, profile: primary, session, candidates: [session.targetUrl, ...state.pages] });
			state.signedIn = outcome.ok;
			if (!outcome.ok) { limitation('signin', `The signed-in product was not reviewed. ${outcome.reason}`); await say(`I couldn't sign in. ${outcome.reason} I'll review the public pages.`); return 'public only'; }
			await say(`Signed in. I'll include the product itself (read-only), starting at \`${pathOf(outcome.url)}\`.`);
			return 'signed in';
		});

		const dossier = pageDossier.map(page => `### ${page.url}${page.status >= 400 ? ` (HTTP ${page.status})` : ''}\nTitle: ${page.title}\n${page.description ? `Description: ${page.description}\n` : ''}${page.text}`).join('\n\n').slice(0, 24_000);
		const brief = state.brief;
		const ownerBrief = [brief.goals ? `Owner's goals: ${brief.goals}` : '', brief.audience ? `Owner's target customers: ${brief.audience}` : '', brief.stage ? `Owner says the stage is: ${brief.stage.replace('_', ' ')}` : '', brief.journeys.length ? `Owner wants these journeys tested: ${brief.journeys.join('; ')}` : '', brief.competitors.length ? `Owner's competitors: ${brief.competitors.join('; ')}` : '', brief.focus.length ? `Owner wants extra attention on: ${brief.focus.map(id => LENSES.find(lens => lens.id === id)?.name).join(', ')}` : ''].filter(Boolean).join('\n') || 'The owner gave no brief; infer the goals and the customer from the site.';

		// 4. Understand the product and the business.
		await stage('understand', async deadline => {
			if (agent) {
				const result = await agent.runStage({
					signal, deadline, maxToolCalls: 8, finish: 'founder_record_business', isDone: () => Boolean(state.business), tools: ['founder_open', 'founder_record_business'],
					task: `You are a seasoned startup founder and product strategist reviewing ${session.targetUrl}. Step 1: understand the product as a business. Read the pages below (open more with founder_open only if something essential is unclear), then call founder_record_business once.\nDecide: what it does, the promise it makes to visitors (quote the headline), who it is for (as stated, and realistically), how it makes money, the one main action it wants a visitor to take, its stage, and 3–6 key user journeys a new customer goes through (for example: understand the offer from the home page; compare plans and pricing; sign up and reach the first moment of value; book a demo; find help). Put the owner's journeys first.\n${ownerBrief}\n\n${dossier}`
				});
				if (!state.business && result.error) limitation('understand', `The reasoning model could not profile the business (${result.error}); a keyword-based profile was used.`);
			}
			if (!state.business) {
				const product = heuristicProduct(pageDossier, session.targetUrl);
				state.business = { name: product.name, category: product.category, oneLiner: product.summary, valueProposition: pageDossier[0]?.title ?? '', targetCustomer: { stated: brief.audience ?? '', inferred: '' }, businessModel: 'unknown', primaryGoal: 'sign_up', stage: brief.stage ?? 'unknown', evidence: product.evidence, heuristic: true };
				state.journeyPlan = [...brief.journeys.map(name => ({ name, goal: name, requestedBy: 'owner' })), { name: 'Understand the offer from the start page', goal: 'Know what it is and why it matters' }, { name: 'Sign up or get started', goal: 'Reach the first step of using it' }].slice(0, 6).map((item, index) => ({ id: `J${index + 1}`, ...item }));
			}
			return `${PRODUCT_CATEGORIES[state.business.category] ?? state.business.category}${state.business.heuristic ? ' (from keywords)' : ''}; ${plural(state.journeyPlan.length, 'journey')} planned`;
		});
		const business = state.business;
		await say(`**${business.name || host}** — ${business.oneLiner} It promises: “${business.valueProposition || 'no clear promise on the first screen'}”. Target customer: ${business.targetCustomer.stated || 'not stated on the site'}${business.targetCustomer.inferred && business.targetCustomer.inferred !== business.targetCustomer.stated ? ` (realistically: ${business.targetCustomer.inferred})` : ''}. Business model: ${business.businessModel.replace(/_/g, ' ')}; main goal: ${business.primaryGoal.replace(/_/g, ' ')}.\n\nI'll walk these journeys:\n${state.journeyPlan.map(item => `- **${item.id}** ${item.name}${item.requestedBy === 'owner' ? ' _(your request)_' : ''}`).join('\n')}`, { id: `founder-understand-${state.startedAt}` });
		await persist();

		// 5. Market research.
		for (const named of brief.competitors) {
			const url = (() => { try { const value = new URL(/^https?:/i.test(named) ? named : `https://${named}`); return value.hostname.includes('.') ? value.href : undefined; } catch { return undefined; } })();
			if (url && !state.sources.some(source => source.url === url)) state.sources.push({ url, title: named, via: 'owner' });
		}
		await stage('market', async deadline => {
			if (!agent) return 'skipped (no reasoning model)';
			const result = await agent.runStage({
				signal, deadline, maxToolCalls: 20, finish: 'founder_record_market', isDone: () => Boolean(state.market), tools: ['web_search', 'web_fetch', 'founder_record_market'],
				task: `Step 2: research the market with web_search and web_fetch, then call founder_record_market.\nProduct: ${JSON.stringify({ name: business.name, category: business.category, oneLiner: business.oneLiner, customer: business.targetCustomer, model: business.businessModel })}\n${ownerBrief}\nFind 2–6 direct competitors or the alternatives this customer would compare it with (search for "${business.category} ${business.oneLiner.split(' ').slice(0, 6).join(' ')} alternatives", "best <category> for <customer> ${new Date().getFullYear()}", and the owner's named competitors). Read their home and pricing pages: how they position themselves, what they charge, their strengths. Then list what users in this category now expect (free trial, integrations, mobile app, onboarding, templates, social proof…) and how this product could stand out. Cite the page you found each competitor on as source_url.`
			});
			if (!state.market) limitation('market', `Competitor research did not complete${result.error ? ` (${result.error})` : ''}; positioning is judged without a competitor comparison.`);
			return state.market ? `${plural(state.market.competitors.length, 'competitor')}` : 'no competitors recorded';
		});
		if (state.market?.competitors?.length) await say(`Competitors I compared against (from ${plural(state.coverage.searches, 'search', 'searches')} and ${plural(state.coverage.fetches, 'page')} read):\n${state.market.competitors.map(item => `- **${item.name}** — ${item.positioning}${item.pricing ? ` · ${item.pricing}` : ''}`).join('\n')}`, { id: `founder-market-${state.startedAt}` });
		await persist();

		// 6. Measured signals.
		await stage('measure', async deadline => {
			const result = await collectSignals({ browser, profile: primary, mobile: VIEWPORTS.mobile, targetUrl: session.targetUrl, pages: state.pages, fetchImpl, save, deadline, progress });
			state.signals = result.signals;
			state.screenshots = result.screenshots;
			state.facts = result.facts;
			const gaps = state.signals.filter(item => ['weak', 'missing'].includes(item.status)).length;
			return `${state.signals.filter(item => item.status === 'good').length} good, ${gaps} to improve`;
		});
		const gaps = state.signals.filter(item => item.status === 'missing');
		await say(`I measured ${plural(state.signals.filter(item => !['unknown', 'not_applicable'].includes(item.status)).length, 'signal')} a first-time visitor feels: ${state.signals.filter(item => item.status === 'good').length} good, ${state.signals.filter(item => item.status === 'weak').length} weak, ${gaps.length} missing${gaps.length ? ` — ${gaps.slice(0, 5).map(item => item.title.toLowerCase()).join('; ')}` : ''}.`, { id: `founder-measure-${state.startedAt}` });
		await persist();

		// 7. Journeys as the target customer.
		await stage('journeys', async deadline => {
			const open = () => state.journeyPlan.filter(item => !state.journeys.some(done => done.id === item.id));
			if (agent && open().length) {
				const signalList = state.signals.map(item => `${item.id} [${item.status}] ${item.title}: ${item.detail}`).join('\n').slice(0, 6000);
				await agent.runStage({
					signal, deadline, maxToolCalls: Math.min(80, open().length * 10 + 6), finish: 'founder_record_journey', nudges: 1,
					isDone: () => open().length === 0, tools: ['founder_open', 'founder_click', 'founder_type', 'founder_scroll', 'founder_press', 'founder_record_journey'],
					nudge: () => `These journeys are not recorded yet: ${open().map(item => `${item.id}: ${item.name}`).join('; ')}. Walk them if time allows, then record each with founder_record_journey.`,
					task: `Step 3: walk each journey below as ${business.targetCustomer.inferred || business.targetCustomer.stated || 'a first-time visitor'} who has never heard of ${business.name || host}, and record each one with founder_record_journey.\nBe honest and specific, like a usability test: where did you hesitate, what was unclear, what was missing, what made you doubt, how many steps it took, where would a real customer give up and what that costs the business. Note what works well too. Form submissions are blocked by the host: judge forms by their content, length and how they react, and record "partial" when the journey would continue past a blocked submission.\n${ownerBrief}\nMeasured signals you may refer to:\n${signalList}\n\nJourneys:\n${open().map(item => `${item.id}: ${item.name} — goal: ${item.goal}${item.startUrl ? ` (start at ${item.startUrl})` : ''}`).join('\n')}`
				});
			}
			for (const item of open()) state.journeys.push({ ...item, outcome: 'not_attempted', steps: [], friction: [], delights: [], summary: agent ? 'Not walked in the time available.' : 'Not walked (no reasoning model).' });
			state.journeys.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
			const walked = state.journeys.filter(item => item.outcome !== 'not_attempted').length;
			if (walked < state.journeys.length) limitation('journeys', `${plural(state.journeys.length - walked, 'journey')} could not be walked: ${state.journeys.filter(item => item.outcome === 'not_attempted').map(item => item.id).join(', ')}.`);
			return `${walked} of ${plural(state.journeys.length, 'journey')} walked`;
		});
		const walked = state.journeys.filter(item => item.outcome !== 'not_attempted');
		if (walked.length) await say(`Journeys walked:\n${walked.map(item => `- **${item.id} ${item.name}** — ${item.outcome}${item.friction.length ? `, ${plural(item.friction.length, 'friction point')}` : ''}. ${item.summary}`).join('\n')}`, { id: `founder-journeys-${state.startedAt}` });
		await persist();

		// 8. Score the business lenses.
		const evidenceBlock = () => [
			`Business: ${JSON.stringify(business)}`, ownerBrief,
			`Signals:\n${state.signals.map(item => `${item.id} [${item.status}] ${item.title}: ${item.detail}`).join('\n')}`,
			`Journeys:\n${state.journeys.map(item => `${item.id} ${item.name} — ${item.outcome}: ${item.summary} Friction: ${item.friction.map(entry => `[${entry.severity}] ${entry.issue}`).join('; ') || 'none'}. Worked: ${item.delights.join('; ') || '—'}`).join('\n')}`,
			state.market ? `Market:\n${state.market.competitors.map(item => `${item.id} ${item.name}: ${item.positioning}; pricing ${item.pricing || 'unknown'}; strengths ${item.strengths.join(', ')}`).join('\n')}\nCategory expectations: ${state.market.expectations.join('; ')}\nDifferentiation ideas: ${state.market.differentiation.join('; ')}` : 'Market: not researched.'
		].join('\n\n').slice(0, 26_000);
		await stage('evaluate', async deadline => {
			if (agent) {
				const missing = () => LENS_IDS.filter(id => !state.lenses[id]);
				await agent.runStage({
					signal, deadline, maxToolCalls: LENS_IDS.length + 4, finish: 'founder_score_lens', isDone: () => missing().length === 0, tools: ['founder_score_lens'], nudges: 2,
					nudge: () => `These areas are not scored yet: ${missing().join(', ')}. Call founder_score_lens once for each of them now.`,
					task: `Step 4: score the product on each business area with founder_score_lens (one call per area). Judge it the way the target customer and a demanding investor would, against the competitors and what users in this category expect. Use the full 0–10 range and cite evidence ids for every score.\nAreas:\n${LENSES.map(lens => `${lens.id}: ${lens.name} — ${lens.question}`).join('\n')}\n\n${evidenceBlock()}`
				});
			}
			const scored = Object.keys(state.lenses).length;
			if (scored < LENS_IDS.length) limitation('evaluate', `${LENS_IDS.length - scored} business areas were scored from the measured signals only.`);
			return `${scored} of ${LENS_IDS.length} areas scored by the reviewer`;
		});
		await persist();

		// 9. Recommendations: do, avoid, keep.
		await stage('recommend', async deadline => {
			if (agent) {
				await agent.runStage({
					signal, deadline, maxToolCalls: 3, finish: 'founder_record_recommendations', isDone: () => state.recommendations.length > 0, tools: ['founder_record_recommendations'],
					task: `Step 5: advise the founder. Call founder_record_recommendations with 6–15 recommendations that will make this product polished and attractive to its target customers, most valuable first, plus 1–5 things that already work and should be kept.\nMix: changes to make (kind "do") and things to stop doing or never do (kind "avoid" — for example "Don't ask for a phone number at sign-up", "Don't launch paid ads before the home page explains the product"). Be specific to THIS product: rewrite the headline, name the fields to cut, the proof to add, the competitor feature to answer. Each needs the business reason (what it costs now, what it gains), concrete steps, the metric to watch, how to know it is done, and evidence ids. Priority "now" = fix before spending on acquisition; "next" = this quarter; "later" = nice to have. Respect the owner's goals and focus areas.\nScores so far: ${LENS_IDS.map(id => `${id}: ${state.lenses[id]?.score ?? 'n/a'} — ${state.lenses[id]?.verdict ?? ''}`).join('\n')}\n\n${evidenceBlock()}`
				});
			}
			if (!state.recommendations.length) { state.recommendations = fallbackRecommendations(state); if (agent) limitation('recommend', 'The recommendations were written from the measured signals.'); }
			return `${plural(state.recommendations.length, 'recommendation')}`;
		});
	} catch (error) {
		if (error?.policyBlocked) limitation('open', error.message);
		else if (error?.expected) limitation('open', 'The product could not be loaded, so nothing could be reviewed.');
		else if (!stopped()) {
			console.error('[founder-engine] unexpected failure; publishing what was collected:', error);
			limitation(state.phase, `The review hit an unexpected error during "${state.phase}" and published what was collected: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}`);
		}
	} finally {
		if (record) { record.qaAnswer = undefined; record.founderReply = undefined; }
		if (['qa_credentials', 'founder_brief'].includes(session.pendingQuestion?.kind)) { session.pendingQuestion = undefined; try { await runStore.commit(session, 'question', { question: null }); } catch { /* best effort */ } }
		await browse?.close?.().catch?.(() => {});
		await browser?.close().catch(() => {});
	}

	// 10. Report — always runs.
	if (stopped()) limitation(state.phase, 'Stopped by the user before every step finished; the review covers the work completed until then.');
	for (const [id] of STAGES) if (id !== 'report' && (!state.phases[id] || state.phases[id].status === 'running')) state.phases[id] = { status: 'skipped', detail: stopped() ? 'Stopped by user' : 'Not reached' };
	if (stopped() && session.status === 'awaiting_input') await runStore.setStatus(session, 'running', 'Publishing the review');
	state.phase = 'report';
	state.phases.report = { status: 'running', startedAt: Date.now() };
	await syncTodos();
	try {
		if (!state.recommendations.length) state.recommendations = fallbackRecommendations(state);
		const draft = buildFounderReport(session);
		if (agent && !stopped() && state.signals.length) {
			await agent.runStage({ signal: undefined, deadline: Date.now() + 120_000, maxToolCalls: 2, finish: 'founder_finish', isDone: () => Boolean(state.summary), tools: ['founder_finish'], nudges: 1,
				task: `Final step: write the executive summary for the founder and call founder_finish. Also suggest a sharper one-line positioning and 2–3 hero headline options.\nBusiness: ${JSON.stringify({ name: state.business?.name, oneLiner: state.business?.oneLiner, promise: state.business?.valueProposition, customer: state.business?.targetCustomer })}\nReadiness: ${draft.readiness}/100 (${draft.verdictLabel})\nScores: ${draft.lenses.map(lens => `${lens.name}: ${lens.score ?? 'n/a'}`).join('; ')}\nDo now: ${draft.priorities.join('; ') || 'none'}\nCompetitors: ${(state.market?.competitors ?? []).map(item => item.name).join(', ') || 'not researched'}\nNot covered: ${state.limitations.map(item => item.message).join(' | ') || 'nothing'}\nBe direct and constructive; no hype.` }).catch(() => undefined);
		}
		agent?.dispose();
		const report = redact(session.id, buildFounderReport(session));
		state.report = report;
		state.finalizedAt = new Date(report.ts).toISOString();
		const findings = founderFindings(session, report).map(item => redact(session.id, { id: randomUUID(), ts: Date.now(), engine: session.engine, status: 'open', statusTs: Date.now(), statusNote: '', ...item }));
		session.findings = findings;
		for (const finding of findings) { try { await runStore.commit(session, 'finding', { finding }); } catch { /* best effort */ } }
		state.status = 'done';
		state.phases.report = { status: 'done', detail: `${report.readiness ?? '—'}/100 · ${report.verdictLabel}`, startedAt: state.phases.report.startedAt, endedAt: Date.now() };
		state.elapsedMs = Date.now() - started - pausedMs;
		await syncTodos();
		await persist({ checkpoint: true });
		// founder.finalized publishes the recommendation set for the Studio handoff.
		await runStore.commit(session, 'founder.finalized', { report, finalizedAt: state.finalizedAt, checkpoint: true });
		for (const item of report.recommendations.filter(entry => entry.priority === 'now').slice(0, 6)) await say(`**${item.kind === 'avoid' ? 'Avoid' : 'Do now'}** · ${item.title}`, { kind: 'founder-rec', id: `founder-rec-${report.ts}-${item.id}` });
		await say(report.summary, { kind: 'founder-report', id: `founder-report-${report.ts}` });
		await runStore.setStatus(session, 'done');
	} catch (error) {
		console.error('[founder-engine] report failed:', error);
		state.status = 'error';
		await persist({ checkpoint: true });
		await runStore.setStatus(session, 'error', `The review could not be saved: ${String(error?.message ?? error).slice(0, 200)}`);
	}
}
