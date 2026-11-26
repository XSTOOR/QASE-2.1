/**
 * Dynamic test planning. The plan is generated from the application graph
 * (what QASE observed) crossed with the capability registry, plus journeys the
 * reasoning model proposes from the graph. It is revised whenever execution
 * teaches the engine something new (a page, a feature, a role, a session
 * change), and every revision is recorded.
 *
 * A scenario is one execution unit: { id, unit, title, targets, capabilities,
 * priority, state, reason, origin, revision, sideEffects }.
 */
import { UNTRUSTED_CONTENT_RULE } from '../untrustedContent.js';
import { CAPABILITIES, applicability } from './capabilities.js';

export const SCENARIO_STATES = ['pending', 'running', 'passed', 'failed', 'blocked', 'inconclusive', 'not_applicable', 'unsupported', 'not_executed'];
const MULTI_PAGE = new Set(['dom_idle', 'viewports', 'keyboard', 'history', 'persistence', 'hover', 'reduced_motion', 'dark_mode', 'injection', 'performance', 'offline', 'slow_network', 'memory', 'storage', 'seo', 'i18n', 'permissions', 'authz', 'roles']);
export const TERMINAL = new Set(SCENARIO_STATES.filter(state => !['pending', 'running'].includes(state)));

const UNIT_TITLES = {
	page_audit: 'Page audit', dom_idle: 'DOM stability and idle animations',
	viewports: 'Responsive layout on other viewports', interactions: 'Menus, toggles, dialogs and their animations', hover: 'Hover submenus',
	reduced_motion: 'Reduced-motion preference', forms: 'Form validation (never submitted)', security_origin: 'Headers, cookies, CORS and exposed files',
	injection: 'XSS and SQL-error probes', redirects: 'Open-redirect probes', links: 'Link check', explore: 'User journey', visual: 'AI visual review',
	keyboard: 'Keyboard navigation and structure', history: 'Back/forward navigation', persistence: 'Reload and session persistence', offline: 'Offline and third-party failure',
	slow_network: 'Slow network', performance: 'Performance timings', memory: 'Memory growth', seo: 'Search-engine metadata', pwa: 'Web app manifest',
	i18n: 'Language and translation keys', media: 'Media captions and autoplay', permissions: 'Permission prompts on load', websocket: 'WebSocket health',
	storage: 'Browser storage', search: 'Search, filters, sorting and pagination', authz: 'Signed-out access to signed-in pages', roles: 'Role restrictions', dark_mode: 'Dark colour scheme'
};

// Lower is earlier. Authorization and core flows first, broad review last.
const PRIORITY = { authz: 1, roles: 1, explore: 2, search: 2, forms: 2, interactions: 3, viewports: 3, keyboard: 3, injection: 3, security_origin: 3, persistence: 4, history: 4, redirects: 4, links: 4, performance: 4, offline: 5, slow_network: 5, storage: 5, seo: 5, pwa: 5, i18n: 5, media: 4, permissions: 5, websocket: 4, hover: 4, reduced_motion: 4, dom_idle: 4, dark_mode: 5, memory: 6, visual: 7 };

/**
 * The scenario contract: why it exists (the observed feature), what it does, what
 * a pass looks like, which evidence it must leave, and when it counts as done.
 * Built from the registry entries of the categories the unit covers.
 */
function describe(unit, targets = [], feature) {
	const caps = CAPABILITIES.filter(item => item.units.includes(unit) && item.support !== 'unsupported');
	return {
		feature: feature ?? (targets.length ? `${UNIT_TITLES[unit] ?? unit} on ${targets.slice(0, 3).map(pathOf).join(', ')}` : 'site-wide'),
		objective: UNIT_TITLES[unit] ?? unit,
		preconditions: caps.some(item => item.access === 'signed_in') ? 'Signed-in session' : 'Page reachable',
		expected: caps.slice(0, 4).map(item => item.pass),
		evidenceRequired: [...new Set(caps.flatMap(item => item.evidence))].slice(0, 5),
		completion: targets.length ? `Every target (${targets.length}) checked, or the reason it was not recorded` : 'The site-level check ran to the end'
	};
}

const capabilitiesFor = unit => CAPABILITIES.filter(item => item.units.includes(unit) && item.support !== 'unsupported').map(item => item.id);

const pathOf = url => { try { const parsed = new URL(url); return `${parsed.pathname}${parsed.search}` || '/'; } catch { return url; } };

/** What scenarios the graph calls for right now. Deterministic for a given graph. */
export function scenariosFromGraph({ graph: model, start, signedInUrl, signedIn, options }) {
	const graph = model.graph;
	const ranked = model.ranked(start, signedInUrl);
	const key = ranked.slice(0, options.secondaryPages);
	const out = [];
	const add = (unit, targets, extra = {}) => {
		const id = `${unit}:${(targets ?? []).map(pathOf).join('|') || 'site'}`;
		out.push({ id, unit, title: extra.title ?? `${UNIT_TITLES[unit] ?? unit}${targets?.length === 1 ? ` — ${pathOf(targets[0])}` : ''}`, targets: targets ?? [], capabilities: capabilitiesFor(unit), priority: PRIORITY[unit] ?? 5, sideEffects: false, ...describe(unit, targets, extra.feature), ...extra });
	};
	if (!ranked.length) return out;
	// Pages first seen during execution (journeys, redirects) get the full page audit.
	for (const [url, page] of Object.entries(graph.pages)) if (page.audited === false && (page.status ?? 200) < 400 && !page.login) add('page_audit', [url], { priority: 2, title: `Audit newly found page — ${pathOf(url)}` });
	// Per-page scenarios follow the features each page actually has.
	for (const url of model.withFeature('menus').filter(url => ranked.includes(url)).slice(0, options.interactionPages)) add('interactions', [url]);
	if (!model.withFeature('menus').length) add('interactions', [ranked[0]]);
	for (const url of model.withFeature('forms').filter(url => !graph.pages[url]?.login).slice(0, 6)) add('forms', [url]);
	const byPath = new Map();
	for (const url of [...model.withFeature('search'), ...model.withFeature('pagination'), ...model.withFeature('sort'), ...model.withFeature('filter').filter(url => model.page(url)?.features?.table || model.page(url)?.features?.forms)]) {
		const key = new URL(url).pathname;
		if (!byPath.has(key) || new URL(url).search.length < new URL(byPath.get(key)).search.length) byPath.set(key, url);
	}
	const searchable = [...byPath.values()].slice(0, 4);
	for (const url of searchable) add('search', [url], { priority: graph.pages[url]?.auth === 'protected' ? 1 : 2 });
	for (const url of model.withFeature('media').slice(0, 3)) add('media', [url]);
	for (const url of model.withFeature('websocket').slice(0, 2)) add('websocket', [url]);
	add('viewports', key);
	add('keyboard', key.slice(0, 3));
	add('history', key.slice(0, 3));
	add('persistence', [signedIn && signedInUrl ? signedInUrl : ranked[0]]);
	add('hover', [ranked[0]]);
	add('reduced_motion', [signedInUrl ?? ranked[0]]);
	add('dom_idle', [...new Set([signedInUrl, ...key].filter(Boolean))].slice(0, 3));
	add('dark_mode', key.slice(0, 2));
	add('security_origin', []);
	add('injection', ranked.filter(url => new URL(url).search || (graph.pages[url]?.features?.search ?? 0) > 0 || (graph.pages[url]?.features?.forms ?? 0) > 0).slice(0, 6).concat(start).filter((url, index, list) => list.indexOf(url) === index).slice(0, 6));
	add('redirects', []);
	add('links', []);
	add('performance', key.slice(0, 3));
	add('offline', [ranked[0]]);
	add('slow_network', [ranked[0]]);
	add('memory', [signedInUrl ?? ranked[0]]);
	add('storage', [signedInUrl ?? ranked[0]]);
	add('seo', ranked.filter(url => !['protected', 'signed-in'].includes(graph.pages[url]?.auth)).slice(0, 8));
	add('i18n', key.slice(0, 4));
	add('permissions', key.slice(0, 2));
	if ((graph.features.manifest ?? 0) > 0) add('pwa', []);
	if (signedIn) {
		const protectedPages = Object.entries(graph.pages).filter(([, page]) => (page.discoveredBy === 'signed-in' || page.auth === 'protected') && (page.status ?? 200) < 400 && !page.login).map(([url]) => url).slice(0, 10);
		if (protectedPages.length) add('authz', protectedPages);
		const restricted = model.withFeature('restricted').concat(Object.entries(graph.pages).filter(([, page]) => [401, 403].includes(page.status)).map(([url]) => url));
		if (restricted.length) add('roles', [...new Set(restricted)].slice(0, 4));
	}
	add('visual', []);
	return out;
}

/** Ask the reasoner which journeys matter for this application (optional). */
export function authorizedSaveJourney(model, allowWrites) {
	if (allowWrites !== true) return undefined;
	const entry = Object.entries(model.graph.pages).find(([, page]) => page.features?.recordForm > 0 && !page.login && !page.features.checkout && (page.status ?? 200) < 400);
	if (!entry) return undefined;
	const [start, page] = entry;
	const url = new URL(start);
	const path = url.pathname + (url.hash.startsWith('#/') ? url.hash.split('?')[0] : '');
	const form = page.features.recordForm;
	return { start, goal: `On ${path}, test the record creation form (form ${form}). Submit it empty, observe validation, then correct it with ordinary synthetic test data. Submit once and verify its receipt. Finish this journey before exploring other pages.`,
		saveTarget: { path, form }, priority: 1, origin: 'graph' };
}

export async function proposeJourneys({ models, model, focus, signal, max = 3, reservedSave }) {
	if (!models.reasonerAvailable()) return { journeys: [], source: 'none' };
	const result = await models.json([
		{ role: 'system', content: 'You plan exploratory QA for a web application you have just observed. Together, your journeys must cover EVERY feature area listed (each screen and each panel/tab/dialog reached by clicking): give each area its own journey that opens it, exercises its sub-features (tabs, menus, buttons, filters, settings, empty and error states) and checks the results. Journeys are read-only (writes are blocked) and achievable in about 20 browser actions; say in the goal which controls to use to get there (e.g. click "Projects" in the sidebar). Do not plan journeys about the sign-in page when the session is signed in. Journeys run in one desktop browser window: do not plan viewport/mobile/resize journeys (responsive layout, accessibility audits, security headers and performance are covered by separate automated checks); spend journeys on behaviour inside the app, going into sub-features (tabs inside panels, list items, settings sections). Answer JSON only: {"journeys":[{"goal":"…","start":"/path","why":"…","priority":1}]} ' + UNTRUSTED_CONTENT_RULE },
		{ role: 'user', content: `${model.summary(40)}${focus ? `\nOwner's focus: ${focus}` : ''}${reservedSave ? `\nA separate authorized journey handles one record save on ${reservedSave.path}. Leave that form to that journey.` : ''}\nPropose up to ${max} journeys covering every feature area, most important first.` }
	], { maxTokens: 1500, signal, purpose: 'planning' }).catch(() => undefined);
	const journeys = (Array.isArray(result?.journeys) ? result.journeys : [])
		.filter(item => typeof item?.goal === 'string' && item.goal.trim())
		.slice(0, max)
		.map(item => ({ goal: item.goal.slice(0, 300), start: typeof item.start === 'string' ? item.start.slice(0, 300) : undefined, why: typeof item.why === 'string' ? item.why.slice(0, 300) : undefined, priority: Number.isInteger(item.priority) ? Math.min(5, Math.max(1, item.priority)) : 2 }));
	return { journeys, source: journeys.length ? 'reasoner' : 'none' };
}

/** A deterministic journey when the reasoner is unavailable: walk the main features. */
export function fallbackJourney(model) {
	const features = Object.entries(model.graph.features).filter(([, n]) => n > 0).map(([key]) => key).filter(key => !['external_links', 'third_party', 'headings'].includes(key));
	return { goal: `Use the main features a visitor would use (${features.slice(0, 6).join(', ') || 'navigation'}) and confirm each responds correctly.`, priority: 2 };
}

export function createPlan(saved) {
	const plan = saved && typeof saved === 'object' ? saved : { scenarios: [], revisions: [], createdAt: undefined };
	plan.scenarios ??= []; plan.revisions ??= [];
	return plan;
}

/**
 * Merge freshly derived scenarios into the plan. Existing scenarios keep their
 * state; scenarios whose targets changed get a new id (the old one stays, so
 * nothing executed disappears). Returns the revision that was recorded, if any.
 */
export function revisePlan(plan, derived, { trigger, journeys = [] } = {}) {
	const known = new Set(plan.scenarios.map(item => item.id));
	const revision = plan.revisions.length + 1;
	const added = [];
	for (const candidateScenario of derived) {
		let scenario = candidateScenario;
		if (known.has(scenario.id)) continue;
		const same = plan.scenarios.filter(item => item.unit === scenario.unit);
		// The same unit on the same site-level scope is already planned: do not duplicate.
		if (!scenario.targets.length && same.some(item => !item.targets.length)) continue;
		// Multi-page units are extended with the pages they have not covered yet, never repeated.
		if (MULTI_PAGE.has(scenario.unit) && same.length) {
			const covered = new Set(same.flatMap(item => item.targets));
			const fresh = scenario.targets.filter(url => !covered.has(url));
			if (!fresh.length) continue;
			scenario = { ...scenario, id: `${scenario.unit}:${fresh.map(pathOf).join('|')}`, targets: fresh, title: `${UNIT_TITLES[scenario.unit] ?? scenario.unit} — newly found ${fresh.length === 1 ? pathOf(fresh[0]) : `${fresh.length} pages`}` };
			if (known.has(scenario.id)) continue;
		}
		const entry = { ...scenario, state: 'pending', origin: plan.revisions.length ? 'replan' : 'graph', revision };
		plan.scenarios.push(entry);
		added.push(entry.id);
	}
	for (const journey of journeys) {
		const id = `explore:${journey.goal.slice(0, 60)}`;
		if (known.has(id) || plan.scenarios.some(item => item.id === id)) continue;
		plan.scenarios.push({ id, unit: 'explore', title: `Journey — ${journey.goal}`, goal: journey.goal, feature: journey.why ?? journey.goal, objective: journey.goal, expected: ['Each step of the journey behaves as a user would expect'], evidenceRequired: ['step trail with what each action changed', 'screenshots of new screens'], completion: 'The model reached the goal, or its step/time budget ended (recorded)', start: journey.start, why: journey.why, targets: [], capabilities: capabilitiesFor('explore'), priority: journey.priority ?? 2, sideEffects: false, state: 'pending', origin: journey.origin ?? 'reasoner', revision });
		if (journey.saveTarget) Object.assign(plan.scenarios.at(-1), {
			saveTarget: journey.saveTarget, sideEffects: true,
			completion: 'Validation, corrected submission and a verified receipt from the planned form.'
		});
		added.push(id);
	}
	if (!added.length) return undefined;
	const entry = { revision, ts: Date.now(), trigger: String(trigger ?? 'initial plan').slice(0, 200), added };
	plan.revisions.push(entry);
	plan.createdAt ??= entry.ts;
	return entry;
}

/** Next scenario to run: highest priority, then plan order. Visual review always runs last. */
export function nextScenario(plan) {
	const pending = plan.scenarios.filter(item => item.state === 'pending');
	if (!pending.length) return undefined;
	const nonVisual = pending.filter(item => item.unit !== 'visual');
	const pool = nonVisual.length ? nonVisual : pending;
	return pool.reduce((best, item) => (item.priority < best.priority ? item : best), pool[0]);
}

/**
 * Resume safety: a scenario that was running when the process stopped is
 * re-queued only when it has no side effects; otherwise its outcome is
 * uncertain and it becomes inconclusive (never replayed automatically).
 */
export function recoverInterrupted(plan) {
	const recovered = [];
	for (const item of plan.scenarios) {
		if (item.state !== 'running') continue;
		if (item.sideEffects) { item.state = 'inconclusive'; item.reason = 'Interrupted while running; it can change data, so QASE did not replay it.'; }
		else { item.state = 'pending'; item.resumed = (item.resumed ?? 0) + 1; }
		recovered.push({ id: item.id, state: item.state });
	}
	return recovered;
}

/** Marks every scenario that did not get to run as not executed, with the reason. */
export function closeOutPlan(plan, reason) {
	for (const item of plan.scenarios) if (!TERMINAL.has(item.state)) { item.state = 'not_executed'; item.reason = reason; }
}

/** unit kind → { executed, errored, notExecuted, reasons } for capability coverage. */
export function unitOutcomes(plan, extra = {}) {
	const units = new Map();
	const bump = (unit, field, reason) => {
		const entry = units.get(unit) ?? { executed: 0, errored: 0, notExecuted: 0, reasons: [] };
		entry[field]++;
		if (reason && entry.reasons.length < 3) entry.reasons.push(reason);
		units.set(unit, entry);
	};
	for (const item of plan.scenarios) {
		if (['passed', 'failed'].includes(item.state)) bump(item.unit, 'executed');
		else if (item.state === 'inconclusive') bump(item.unit, 'errored', item.reason);
		else bump(item.unit, 'notExecuted', item.reason);
	}
	for (const [unit, ran] of Object.entries(extra)) if (ran) bump(unit, 'executed');
	return units;
}

/** Share the available calls across journeys while leaving a tenth of the total
 * (up to 25 calls) for verification and reporting. Retries count as calls. */
export function journeyCallBudget(total, used, pendingJourneys) {
	const reserve = Math.min(25, Math.floor(total / 10));
	const available = total - used - reserve;
	const allocation = available > 0 ? Math.max(1, Math.floor(available / Math.max(1, pendingJourneys))) : 0;
	return { reserve, allocation };
}

export function planSummary(plan) {
	const counts = Object.fromEntries(SCENARIO_STATES.map(state => [state, plan.scenarios.filter(item => item.state === state).length]));
	return { total: plan.scenarios.length, revisions: plan.revisions.length, ...counts };
}

export { applicability };
