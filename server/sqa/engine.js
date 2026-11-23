/**
 * QASE compliance SQA engine (v3).
 *
 * Reasoning-based compliance testing on the CleanSlate SDK, with the reasoning
 * model only (no JEV, no hybrid routing). The host runs fixed stages; the SDK
 * agent does the thinking inside each one:
 *
 *   1. open          load the product, read its key pages (home, about,
 *                    pricing, privacy, terms, accessibility, contact…)
 *   2. signin        ask for / use a test account when there is a sign-in wall
 *   3. identify      agent: what kind of product, for whom, where, what data
 *   4. research      agent: web_search + web_fetch to find the standards and
 *                    laws that apply; each must cite a source it actually found
 *   5. requirements  agent: break every framework into testable requirements
 *   6. evidence      host: measure accessibility, security and privacy signals;
 *                    requirements tied to measured evidence are decided here
 *   7. test          agent: test the remaining requirements in the browser
 *   8. report        host scores; agent writes the summary
 *
 * Completion guarantee: every stage has a deadline and a fallback (heuristic
 * product profile, a labelled baseline of frameworks and requirements, host
 * decisions from measured evidence), so a run always ends with a report even
 * when the model or the internet is unavailable.
 */
import { checkRuntimeIdentity, runtimeName } from '../runRuntime.js';
import { randomUUID } from 'node:crypto';
import { createArtifactStore } from '../artifactStore.js';
import { redact } from '../secrets.js';
import { createQaBrowser, primaryProfile, VIEWPORTS } from '../qa/browser.js';
import { qaModelSettings } from '../qa/models.js';
import { normalizeUrl } from '../qa/crawl.js';
import { signIn, hasLoginForm } from '../qa/signin.js';
import { accountQuestion, waitForAccount } from '../qa/accountQuestion.js';
import { applyUsage } from '../usageCapture.js';
import { createComplianceAgent, sqaModelSettings } from './agent.js';
import { browsingTools, recordProductTool, selectFrameworksTool, defineRequirementsTool, recordResultTool, finishTool, renumber } from './tools.js';
import { collectEvidence } from './evidence.js';
import { PRODUCT_CATEGORIES, EVIDENCE_KINDS, EVIDENCE_FIX, baselineFrameworks, baselineRequirements, fallbackRequirementsFor } from './catalog.js';
import { buildSqaReport, requirementFindings } from './report.js';

export const SQA_ENGINE_VERSION = 3;

export const STAGES = [
	['open', 'Open the product and read its key pages'],
	['signin', 'Sign in with a test account (when needed)'],
	['identify', 'Identify what kind of product this is'],
	['research', 'Research the compliance standards that apply'],
	['requirements', 'Turn each standard into testable requirements'],
	['evidence', 'Measure accessibility, privacy and security evidence'],
	['test', 'Test the remaining requirements in the browser'],
	['report', 'Score compliance and publish the report']
];
// Share of the remaining budget per stage (unused time flows to later stages).
const SHARE = { open: 6, signin: 4, identify: 8, research: 20, requirements: 12, evidence: 14, test: 30, report: 6 };
const STAGE_IDS = STAGES.map(([id]) => id);

const KEY_PAGE = /about|pricing|plans|privacy|terms|cookie|legal|accessib|contact|support|help|faq|course|program|product|features|security|safety|parents|teachers|schools|students|policy|imprint|impressum/i;
const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const pathOf = url => { try { const parsed = new URL(url); return parsed.pathname || '/'; } catch { return url; } };
const positive = (value, fallback, max) => { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.min(max, Math.floor(number)) : fallback; };

export function isSqaEngineSession(session) {
	return session?.mode === 'sqa' && session.sqa?.version === SQA_ENGINE_VERSION;
}

/** State created at launch. `focus` and `regions` are the owner's optional hints. */
export function createSqaRunState({ focus, regions } = {}) {
	return {
		version: SQA_ENGINE_VERSION, engine: 'qase-compliance', status: 'pending', startedAt: Date.now(), updatedAt: Date.now(),
		// Kept for the run store's SQA schema (one profile identifier).
		scope: { profiles: ['compliance'] },
		focus: String(focus ?? '').trim().slice(0, 2000) || undefined,
		regionsHint: String(regions ?? '').trim().slice(0, 300) || undefined,
		phase: 'open', phases: {}, pages: [], visited: [], product: undefined, frameworks: [], requirements: [], evidence: [], sources: [],
		limitations: [], coverage: { pages: 0, searches: 0, fetches: 0 }, models: {}, summary: undefined
	};
}

export function engineOptions(env = process.env) {
	return {
		budgetMs: positive(env.QASE_SQA_MAX_MINUTES, 30, 120) * 60_000,
		keyPages: positive(env.QASE_SQA_KEY_PAGES, 8, 20),
		credentialWaitMs: positive(env.QASE_QA_CREDENTIAL_WAIT_MINUTES, 10, 120) * 60_000,
		askForCredentials: env.QASE_QA_ASK_CREDENTIALS !== 'false'
	};
}

/** Heuristic profile when the model cannot identify the product. */
export function heuristicProduct(pages, targetUrl) {
	const text = pages.map(page => `${page.title} ${page.text}`).join(' ').toLowerCase();
	const score = { education: /course|lesson|learn|student|teacher|school|tutor|class|curriculum|exam|lms|e-learning/g, healthcare: /patient|clinic|doctor|health|medical|therapy|hospital|prescription/g, finance: /bank|loan|invest|insurance|credit|wallet|trading|fintech/g, ecommerce: /cart|shop|checkout|add to bag|order|shipping|product/g, ai: /\bai\b|artificial intelligence|gpt|llm|chatbot|generative/g, saas: /dashboard|workspace|team|integrations|api|platform|pricing/g, media: /article|news|watch|stream|podcast|episode/g, social: /community|forum|followers|profile|post/g, government: /government|ministry|citizen|municipal|department of/g, travel: /hotel|flight|booking|travel|trip/g };
	const ranked = Object.entries(score).map(([category, pattern]) => [category, (text.match(pattern) ?? []).length]).sort((a, b) => b[1] - a[1]);
	const category = ranked[0][1] >= 3 ? ranked[0][0] : 'other';
	const host = (() => { try { return new URL(targetUrl).hostname; } catch { return ''; } })();
	const regions = [/\.in$/.test(host) || /₹|\binr\b|india/.test(text) ? 'India' : '', /\.(uk|de|fr|es|it|nl|ie|eu)$/.test(host) || /€|\beur\b|gdpr/.test(text) ? 'EU' : '', /\$|\busd\b|united states/.test(text) ? 'US' : ''].filter(Boolean);
	return {
		name: pages[0]?.title?.split(/[|–—-]/)[0]?.trim() || host, category, subcategory: PRODUCT_CATEGORIES[category], summary: `Identified from keywords on ${pages.length} page${pages.length === 1 ? '' : 's'} (no reasoning model was available).`,
		audience: { description: 'Not identified', children: /\b(kids|children|parents|k-12|under 13)\b/.test(text), students: /student|pupil/.test(text), businesses: /business|team|enterprise/.test(text) },
		regions, dataHandled: [/sign ?up|log ?in|account/.test(text) ? 'accounts' : '', /checkout|payment|card|pay now/.test(text) ? 'payments' : ''].filter(Boolean), features: [],
		evidence: [`Keyword analysis of ${pages.map(page => pathOf(page.url)).join(', ')}`], heuristic: true
	};
}

/** Runs (or resumes) one compliance assessment to completion. */
export async function runSqaEngine({ session, runStore, record, signal, env = process.env, settings = qaModelSettings(env), artifactStore = createArtifactStore(), fetchImpl: probeFetch = fetch, rootDir }) {
	if (session.report) {
		await runStore.addMessage(session, { role: 'agent', kind: 'qa-step', text: 'This assessment is complete. Start a new compliance review to assess the product again.' });
		return;
	}
	if (!session.targetUrl) {
		await runStore.setStatus(session, 'awaiting_input', 'Waiting for a target URL.');
		return;
	}
	const options = engineOptions(env);
	if (session.sqa?.version !== SQA_ENGINE_VERSION) session.sqa = createSqaRunState();
	const state = session.sqa;
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
	const limitation = (phase, message, affectsCoverage = true) => {
		if (!state.limitations.some(item => item.message === message)) state.limitations.push({ phase, message: String(message).slice(0, 500), affectsCoverage });
	};
	const persist = async ({ checkpoint = false } = {}) => {
		state.updatedAt = Date.now();
		try { await runStore.commit(session, 'sqa.state', { sqa: redact(session.id, state), ...(checkpoint ? { checkpoint: true } : {}) }); } catch (error) { console.warn('[sqa-engine] checkpoint failed:', error?.message); }
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
		try { await runStore.addActivity(session, { id: currentActivity, type: 'tool', toolName: `sqa_${id}`, status: 'running', label: STAGES.find(([key]) => key === id)[1] }); } catch { /* best effort */ }
		const activity = currentActivity;
		try {
			const detail = await work(stageDeadline(id));
			state.phases[id] = { status: /^skipped/i.test(detail ?? '') ? 'skipped' : 'done', detail, startedAt, endedAt: Date.now() };
		} catch (error) {
			if (stopped()) state.phases[id] = { status: 'skipped', detail: 'Stopped by user', startedAt, endedAt: Date.now() };
			else {
				const message = String(error?.message ?? error).split('\n')[0].slice(0, 300);
				console.warn(`[sqa-engine] stage ${id} failed:`, error);
				state.phases[id] = { status: 'failed', detail: message, startedAt, endedAt: Date.now() };
				limitation(id, `${STAGES.find(([key]) => key === id)[1]} did not complete: ${message}`);
				await say(`I couldn't finish this step (${STAGES.find(([key]) => key === id)[1].toLowerCase()}): ${message}. I'm carrying on; the report lists what was missed.`);
			}
		}
		currentActivity = undefined;
		try { await runStore.updateActivity(session, activity, { status: state.phases[id].status === 'failed' ? 'error' : 'done', summary: state.phases[id].detail ?? state.phases[id].status, detail: '' }); } catch { /* best effort */ }
		await syncTodos();
		await persist({ checkpoint: true });
	}

	const model = sqaModelSettings(settings, env);
	state.models = { reasoner: { model: model.model, enabled: model.enabled, calls: state.models?.reasoner?.calls ?? 0 } };
	let browser, browse, agent;
	let fetchImpl = probeFetch;
	let mainResponse = state.mainResponse;
	let cookies = [];
	const primary = primaryProfile(session);
	const pageDossier = [];

	try {
		await runStore.setStatus(session, 'running', 'Assessing compliance');
		browser = await createQaBrowser({ session, allowWrites: false, env, publishFrame: frame => { try { runStore.publish?.(session, 'frame', { frame }); } catch { /* live view is best effort */ } } });
		if (record) record.bridge = { getLastFrame: () => browser?.getLastFrame(), stopFrames: () => browser?.stopFrames() };
		fetchImpl = browser.guardedFetch(probeFetch);
		if (!await browser.policyAllows(session.targetUrl, true)) throw Object.assign(new Error('The target is blocked by the browser safety policy (private or reserved network address).'), { policyBlocked: true });
		browser.startFrames();
		session.runtimeFacts = { ...(session.runtimeFacts ?? {}), ...await browser.observeRuntime(primary) };
		// The browser that ran must be the one selected; any gap is reported, never hidden.
		const runtimeIdentity = checkRuntimeIdentity(session.environmentSnapshot, session.runtimeFacts);
		if (!runtimeIdentity.ok) limitation('open', runtimeIdentity.note);
		if (session.runtimeFacts.brandedBinary?.fallbackUsed) limitation('open', `The installed ${session.environmentSnapshot?.browser ?? 'browser'} failed to start (${session.runtimeFacts.brandedBinary.error}); the run used the bundled ${browser.engine} engine instead.`);
		browse = browsingTools({ browser, profile: primary, state: { ...state, targetUrl: session.targetUrl, visited: state.visited } });
		if (model.enabled) {
			agent = createComplianceAgent({
				session, model, rootDir,
				tools: [...browse.tools, recordProductTool(state), selectFrameworksTool(state), defineRequirementsTool(state), recordResultTool(state), finishTool(state)],
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
							: name === 'sqa_open' ? `Opened ${pathOf(input?.url)}`
								: name === 'sqa_record_result' ? `Recorded ${input?.requirement_id}: ${input?.status}`
									: name.replace(/^sqa_/, '').replace(/_/g, ' ');
					await progress(label);
					if (['web_search', 'web_fetch', 'sqa_open', 'sqa_click', 'sqa_type'].includes(name)) await runStore.addActivity(session, { type: 'tool', toolName: name, status: result?.success === false ? 'error' : 'done', label, summary: result?.success === false ? String(result.error ?? '').slice(0, 200) : undefined });
				}
			});
		} else {
			limitation('identify', 'No reasoning-model key is configured (QASE_API_KEY / QASE_REASONER_API_KEY), so the product was identified heuristically, a labelled baseline of standards was used instead of online research, and only measured evidence was assessed.');
		}
		const browserName = runtimeName(session.environmentSnapshot, browser);
		await say(`I'm assessing **${host}** for compliance in ${browserName}. First I'll work out what kind of product it is, then research which standards and laws apply to it, turn them into testable requirements, measure what can be measured, test the rest in the browser, and report the result per standard.`, { id: `sqa-intro-${state.startedAt}` });

		// 1. Open and read the key pages.
		await stage('open', async deadline => {
			const { page, log } = await browser.openPage(primary);
			browser.setActivePage(page);
			try {
				await browser.goto(page, session.targetUrl, log);
				mainResponse = log.mainResponse;
				if (!mainResponse || mainResponse.status >= 500) throw new Error(`The site responded with HTTP ${mainResponse?.status ?? 'no response'}.`);
				state.mainResponse = { status: mainResponse.status, headers: mainResponse.headers };
				cookies = await page.context().cookies();
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
					const read = await page.evaluate(() => ({ title: document.title, lang: document.documentElement.lang, description: document.querySelector('meta[name=description]')?.content ?? '', text: (document.body?.innerText ?? '').replace(/\n{2,}/g, '\n').slice(0, 2500) })).catch(() => ({ title: '', text: '' }));
					pageDossier.push({ url, ...read });
				} catch { /* unreadable page */ } finally { await page.close().catch(() => {}); }
			}
			state.coverage.pages = pageDossier.length;
			return `HTTP ${mainResponse.status}, ${plural(pageDossier.length, 'page')} read`;
		});
		if (!state.mainResponse) throw Object.assign(new Error('target_unreachable'), { expected: true });
		mainResponse ??= state.mainResponse;
		await say(`The site is up (HTTP ${state.mainResponse.status}). I read ${plural(pageDossier.length, 'key page')}: ${pageDossier.slice(0, 8).map(page => `\`${pathOf(page.url)}\``).join(', ')}.${state.loginWall ? ' The start page is a sign-in screen.' : ''}`, { id: `sqa-open-${state.startedAt}` });

		// 2. Sign-in when there is a wall (or an account was supplied).
		await stage('signin', async () => {
			if (!state.loginWall && !session.qaAuth?.authorized) return 'skipped (no sign-in wall)';
			if (!session.qaAuth?.authorized) {
				if (!options.askForCredentials || session.matrixRunId) return 'skipped (public pages only)';
				const { answer, waitedMs } = await waitForAccount({ session, runStore, record, signal, waitMs: options.credentialWaitMs, question: accountQuestion({ host, purpose: 'assess' }), resumeDetail: 'Assessing compliance' });
				pausedMs += waitedMs;
				if (!answer.credentials) { limitation('signin', 'The signed-in part of the product was not assessed (no test account).'); return 'skipped (public pages only)'; }
			}
			const outcome = await signIn({ browser, profile: primary, session, candidates: [session.targetUrl, ...state.pages] });
			state.signedIn = outcome.ok;
			if (!outcome.ok) { limitation('signin', `Signed-in areas were not assessed. ${outcome.reason}`); await say(`I couldn't sign in. ${outcome.reason} I'll assess the public pages.`); return 'public only'; }
			await say(`Signed in. I'll include the signed-in area (read-only), starting at \`${pathOf(outcome.url)}\`.`);
			return 'signed in';
		});

		const dossier = pageDossier.map(page => `### ${page.url}\nTitle: ${page.title}\n${page.description ? `Description: ${page.description}\n` : ''}${page.lang ? `Language: ${page.lang}\n` : ''}${page.text}`).join('\n\n').slice(0, 24_000);
		const ownerHints = [state.focus ? `Owner's note: ${state.focus}` : '', state.regionsHint ? `Owner says it serves: ${state.regionsHint}` : ''].filter(Boolean).join('\n');

		// 3. Identify the product.
		await stage('identify', async deadline => {
			if (agent) {
				const result = await agent.runStage({
					signal, deadline, maxToolCalls: 8, finish: 'sqa_record_product', isDone: () => Boolean(state.product), tools: ['sqa_open', 'sqa_record_product'],
					task: `You are a compliance analyst. Step 1 of a compliance assessment of ${session.targetUrl}: identify exactly what kind of product this is.\nRead the page texts below (open more pages with sqa_open only if something essential is unclear), then call sqa_record_product once.\nDecide: category and specific type, what it does, who uses it (does it serve children or students?), which countries/regions it serves (language, currency, addresses, phone numbers, stated markets), what personal data it handles, and its relevant features. Cite page evidence for each conclusion. Do not guess beyond the evidence; leave regions empty if unknown.\n${ownerHints}\n\n${dossier}`
				});
				if (!state.product && result.error) limitation('identify', `The reasoning model could not identify the product (${result.error}); a keyword-based profile was used.`);
			}
			if (!state.product) state.product = heuristicProduct(pageDossier, session.targetUrl);
			return `${state.product.category}${state.product.heuristic ? ' (heuristic)' : ''}`;
		});
		state.product ??= heuristicProduct(pageDossier, session.targetUrl);
		const product = state.product;
		await say(`This looks like **${product.subcategory || PRODUCT_CATEGORIES[product.category]}**${product.name ? ` (${product.name})` : ''}. ${product.summary} Audience: ${product.audience.description}${product.audience.children ? ' — including children' : ''}. Regions: ${product.regions.join(', ') || 'not stated'}. Data: ${product.dataHandled.join(', ') || 'not identified'}.`, { id: `sqa-identify-${state.startedAt}` });
		await persist();

		// 4. Research the frameworks that apply.
		await stage('research', async deadline => {
			if (agent) {
				const result = await agent.runStage({
					signal, deadline, maxToolCalls: 24, finish: 'sqa_select_frameworks', isDone: () => state.frameworks.length > 0, tools: ['web_search', 'web_fetch', 'sqa_select_frameworks'],
					task: `Step 2: find the compliance standards and laws that apply to this product, using web_search and web_fetch. Then call sqa_select_frameworks.\nProduct profile: ${JSON.stringify(product)}\n${ownerHints}\nResearch, for this product type, audience and these regions:\n- accessibility law and standards (e.g. WCAG version and the law that requires it in the region),\n- privacy and data-protection law (including children's/student data if relevant),\n- consumer-protection / e-commerce / sector-specific rules (education, health, finance, AI…) that impose requirements a website can show,\n- security standards relevant to the data handled.\nUse official sources (legislation, regulators, standards bodies). Search with specific queries (e.g. "${product.category} website compliance requirements ${product.regions[0] ?? ''}", "<law name> official text"). Prefer current versions (${new Date().getFullYear()}). Select 3–8 frameworks, most important first; explain for each why it applies to THIS product and whether it is legally mandatory or a recommended standard.`
				});
				if (!state.frameworks.length) limitation('research', `Online research did not produce sourced frameworks${result.error ? ` (${result.error})` : ''}; a labelled baseline of standards was used.`);
			}
			if (!state.frameworks.length) state.frameworks = baselineFrameworks(product);
			return `${plural(state.frameworks.length, 'framework')}${state.frameworks.some(item => item.baseline) ? ' (baseline)' : ''}`;
		});
		if (!state.frameworks.length) state.frameworks = baselineFrameworks(product);
		await say(`These standards apply${state.frameworks.some(item => item.baseline) ? ' (baseline set — online research was not available)' : ` (from ${plural(state.coverage.searches, 'search', 'searches')} and ${plural(state.coverage.fetches, 'source')} read)`}:\n${state.frameworks.map(item => `- **${item.name}**${item.mandatory ? '' : ' (recommended)'} — ${item.applicability}`).join('\n')}`, { id: `sqa-research-${state.startedAt}` });
		await persist();

		// 5. Requirements.
		await stage('requirements', async deadline => {
			if (agent) {
				const missing = () => state.frameworks.filter(framework => !state.requirements.some(item => item.frameworkId === framework.id));
				await agent.runStage({
					signal, deadline, maxToolCalls: state.frameworks.length * 3 + 4, finish: 'sqa_define_requirements', isDone: () => missing().length === 0, tools: ['web_fetch', 'sqa_define_requirements'],
					task: `Step 3: break every framework into the requirements that can be checked on this product. Call sqa_define_requirements once per framework (framework ids below). 4–10 requirements per framework, the ones that matter most for this product. Use the exact clause numbers (read the source with web_fetch if you need them). Mark how each can be checked: "automated" when one of the measured evidence kinds decides it (set evidence_kinds), "browser" when a tester can verify it by using the site (reading the privacy policy content, checking a consent flow, keyboard navigation, age gate…), "document" when it needs internal documents.\nProduct: ${JSON.stringify(product)}\nFrameworks:\n${state.frameworks.map(item => `${item.id}: ${item.name} — ${item.url} — ${item.applicability}`).join('\n')}`
				});
			}
			for (const framework of state.frameworks) {
				if (state.requirements.some(item => item.frameworkId === framework.id)) continue;
				const fallback = framework.baseline ? baselineRequirements([framework]) : fallbackRequirementsFor(framework);
				if (fallback.length) state.requirements.push(...fallback);
				else limitation('requirements', `No testable requirements were derived for ${framework.name}.`);
			}
			renumber(state);
			return `${plural(state.requirements.length, 'requirement')}`;
		});
		renumber(state);
		const methods = method => state.requirements.filter(item => item.method === method).length;
		await say(`I turned them into **${plural(state.requirements.length, 'requirement')}**: ${methods('automated')} I can measure, ${methods('browser')} to check in the browser and ${methods('document')} that need internal documents.`, { id: `sqa-requirements-${state.startedAt}` });
		await persist();

		// 6. Measured evidence; requirements tied to it are decided here.
		await stage('evidence', async deadline => {
			state.evidence = await collectEvidence({ browser, profile: primary, mobile: VIEWPORTS.mobile, targetUrl: session.targetUrl, pages: state.pages, mainResponse, cookies, fetchImpl, save, deadline, progress });
			let decided = 0;
			for (const requirement of state.requirements) {
				if (requirement.status !== 'untested' || !requirement.evidenceKinds?.length) continue;
				const items = requirement.evidenceKinds.map(kind => state.evidence.find(item => item.kind === kind)).filter(Boolean);
				if (!items.length || items.some(item => item.status === 'unknown')) continue;
				const issues = items.filter(item => item.status === 'issue');
				const status = issues.length ? 'fail' : items.every(item => item.status === 'not_applicable') ? 'not_applicable' : 'pass';
				Object.assign(requirement, { status, decidedBy: 'measured', evidenceIds: items.map(item => item.id), observed: issues.length ? issues.map(item => item.detail).join(' | ').slice(0, 1200) : items.map(item => `${item.title}: ${item.detail}`).join(' | ').slice(0, 600), url: issues.flatMap(item => item.urls)[0], fix: issues.length ? issues.map(item => EVIDENCE_FIX[item.kind]).filter(Boolean).join(' ') : undefined });
				decided++;
			}
			const issues = state.evidence.filter(item => item.status === 'issue').length;
			return `${state.evidence.length - issues} checks ok, ${issues} issues; ${decided} requirements decided`;
		});
		const evidenceIssues = state.evidence.filter(item => item.status === 'issue');
		await say(`I measured ${plural(state.evidence.filter(item => item.status !== 'not_applicable').length, 'check')} (accessibility, security, privacy and consent): ${evidenceIssues.length ? `**${evidenceIssues.length} problems** — ${evidenceIssues.slice(0, 5).map(item => item.title.replace(/\s*\(.*\)$/, '')).join('; ')}` : 'no problems found'}. That decided ${plural(state.requirements.filter(item => item.decidedBy === 'measured').length, 'requirement')}.`, { id: `sqa-evidence-${state.startedAt}` });
		await persist();

		// 7. Browser testing of what is left.
		await stage('test', async deadline => {
			const open = () => state.requirements.filter(item => item.status === 'untested');
			if (agent && open().length) {
				const evidenceList = state.evidence.map(item => `${item.id} [${item.status}] ${item.title}: ${item.detail}`).join('\n').slice(0, 9000);
				await agent.runStage({
					signal, deadline, maxToolCalls: Math.min(90, open().length * 4 + 10), finish: 'sqa_record_result', nudges: 1,
					isDone: () => open().length === 0, tools: ['sqa_open', 'sqa_click', 'sqa_type', 'sqa_scroll', 'sqa_press', 'web_fetch', 'sqa_record_result'],
					task: `Step 4: test the open requirements on ${session.targetUrl} and record every one with sqa_record_result.\nWork like an auditor: open the relevant page (privacy policy, sign-up, consent banner, footer, help, course pages…), check exactly what the requirement says, and record pass / fail / partial with what you observed and the page. For requirements that need internal documents, record needs_documents. If a requirement turns out not to apply, record not_applicable and say why. Form submissions are blocked by the host, so judge forms by their content, labels, notices and client-side behaviour.\nProduct: ${product.subcategory || product.category} — ${product.summary}\nMeasured evidence you can cite (ids):\n${evidenceList}\n\nOpen requirements:\n${open().map(item => `${item.id} [${item.method}] ${state.frameworks.find(entry => entry.id === item.frameworkId)?.name} ${item.clause}: ${item.title} — check: ${item.check}`).join('\n')}`
				});
			}
			for (const requirement of open()) {
				if (requirement.method === 'document') Object.assign(requirement, { status: 'needs_documents', decidedBy: 'host', observed: 'Requires internal documentation that cannot be verified from outside.' });
			}
			const left = open().length;
			if (left) limitation('test', `${plural(left, 'requirement')} could not be tested in the time available: ${open().slice(0, 8).map(item => item.id).join(', ')}.`);
			return `${plural(state.requirements.length - left, 'requirement')} decided${left ? `, ${left} not tested` : ''}`;
		});
		const tested = state.requirements.filter(item => item.decidedBy === 'agent').length;
		await say(`Browser testing done: I checked ${plural(tested, 'requirement')} by using the product.`, { id: `sqa-test-${state.startedAt}` });
	} catch (error) {
		if (error?.policyBlocked) limitation('open', error.message);
		else if (error?.expected) limitation('open', 'The product could not be loaded, so nothing could be assessed.');
		else if (!stopped()) {
			console.error('[sqa-engine] unexpected failure; publishing what was collected:', error);
			limitation(state.phase, `The assessment hit an unexpected error during "${state.phase}" and published what was collected: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}`);
		}
	} finally {
		if (record) record.qaAnswer = undefined;
		if (session.pendingQuestion?.kind === 'qa_credentials') { session.pendingQuestion = undefined; try { await runStore.commit(session, 'question', { question: null }); } catch { /* best effort */ } }
		await browse?.close?.().catch?.(() => {});
		await browser?.close().catch(() => {});
	}

	// 8. Report — always runs.
	if (stopped()) limitation(state.phase, 'Stopped by the user before every step finished; the report covers the work completed until then.');
	for (const [id] of STAGES) if (id !== 'report' && (!state.phases[id] || state.phases[id].status === 'running')) state.phases[id] = { status: 'skipped', detail: stopped() ? 'Stopped by user' : 'Not reached' };
	if (stopped() && session.status === 'awaiting_input') await runStore.setStatus(session, 'running', 'Publishing the results');
	state.phase = 'report';
	state.phases.report = { status: 'running', startedAt: Date.now() };
	await syncTodos();
	try {
		if (agent && !stopped() && state.requirements.length) {
			const scores = state.frameworks.map(framework => { const items = state.requirements.filter(item => item.frameworkId === framework.id); return `${framework.name}: ${items.filter(item => item.status === 'pass').length} pass, ${items.filter(item => item.status === 'fail').length} fail, ${items.filter(item => item.status === 'partial').length} partial, ${items.filter(item => item.status === 'needs_documents').length} need documents`; });
			const gaps = state.requirements.filter(item => ['fail', 'partial'].includes(item.status)).slice(0, 25).map(item => `${item.id} [${item.severity}] ${item.title}: ${item.observed?.slice(0, 200)}`);
			await agent.runStage({ signal: undefined, deadline: Date.now() + 120_000, maxToolCalls: 2, finish: 'sqa_finish', isDone: () => Boolean(state.summary), tools: ['sqa_finish'], nudges: 1,
				task: `Final step: write the executive summary of this compliance assessment and call sqa_finish.\nProduct: ${JSON.stringify({ name: state.product?.name, type: state.product?.subcategory, audience: state.product?.audience?.description, regions: state.product?.regions })}\nResults per framework:\n${scores.join('\n')}\nGaps:\n${gaps.join('\n') || 'none'}\nNot covered: ${state.limitations.map(item => item.message).join(' | ') || 'nothing'}\nBe factual; do not claim certification.` }).catch(() => undefined);
		}
		agent?.dispose();
		const report = redact(session.id, buildSqaReport(session));
		const findings = requirementFindings(session).map(item => redact(session.id, { id: randomUUID(), ts: Date.now(), engine: session.engine, status: 'open', statusTs: Date.now(), statusNote: '', ...item }));
		session.findings = findings;
		for (const finding of findings) { try { await runStore.commit(session, 'finding', { finding }); } catch { /* best effort */ } }
		session.report = report;
		state.status = 'done';
		state.phases.report = { status: 'done', detail: report.verdictLabel, startedAt: state.phases.report.startedAt, endedAt: Date.now() };
		state.elapsedMs = Date.now() - started - pausedMs;
		await syncTodos();
		await persist({ checkpoint: true });
		await runStore.commit(session, 'report', { report });
		const ordered = [...findings].sort((a, b) => ['critical', 'high', 'medium', 'low', 'info'].indexOf(a.severity) - ['critical', 'high', 'medium', 'low', 'info'].indexOf(b.severity));
		for (const finding of ordered.slice(0, 10)) await say(`**${finding.severity.toUpperCase()}** · ${finding.title}`, { kind: 'qa-finding', id: `qaf-${finding.id}` });
		if (ordered.length > 10) await say(`…and ${plural(ordered.length - 10, 'more gap')} in the SQA tab and the report.`, { id: `sqa-more-${report.ts}` });
		await say(report.summary, { kind: 'sqa-report', id: `sqa-report-${report.ts}` });
		await runStore.setStatus(session, 'done');
	} catch (error) {
		console.error('[sqa-engine] report failed:', error);
		state.status = 'error';
		await persist({ checkpoint: true });
		await runStore.setStatus(session, 'error', `The report could not be saved: ${String(error?.message ?? error).slice(0, 200)}`);
	}
}

export { EVIDENCE_KINDS };
