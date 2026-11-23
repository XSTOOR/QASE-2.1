/**
 * Custom SDK tools for compliance SQA.
 *
 * Browsing tools drive the host's policy-guarded QA browser (target scope,
 * private-network protection, writes blocked). Recording tools validate the
 * agent's structured output and write it into session.sqa; the host — not the
 * model — computes scores and the verdict from what was recorded.
 */
import { observe } from '../qa/explorer.js';
import { EVIDENCE_KINDS, PRODUCT_CATEGORIES } from './catalog.js';

const DESTRUCTIVE = /\b(delete|remove|destroy|erase|log ?out|sign ?out|unsubscribe|deactivate|pay|purchase|buy now|checkout|place order|transfer|close account|submit order)\b/i;
const text = (value, max = 2000) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const list = (value, max = 20, length = 300) => (Array.isArray(value) ? value : []).map(item => text(item, length)).filter(Boolean).slice(0, max);
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const METHODS = ['automated', 'browser', 'document'];
export const RESULT_STATUSES = ['pass', 'fail', 'partial', 'needs_documents', 'not_applicable'];
export const DATA_TYPES = ['accounts', 'personal_data', 'payments', 'health', 'children', 'education_records', 'location', 'biometrics', 'user_content', 'ai_inputs', 'financial'];

const tool = (name, description, properties, required, run) => ({ name, category: name.split('_')[0], description, parametersSchema: { type: 'object', properties, required }, run });
const hostOf = url => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } };

/** Tools that read and interact with the product under test. */
export function browsingTools({ browser, profile, state, onVisit = () => {}, prefix = 'sqa' }) {
	let page, log;
	const ensure = async () => {
		if (page && !page.isClosed()) return;
		({ page, log } = await browser.openPage(profile));
		browser.setActivePage(page);
	};
	const visit = () => { const url = page.url().split('#')[0]; if (!state.visited.includes(url)) state.visited.push(url); onVisit(url); };
	const after = async () => { await browser.settle(page, { quietMs: 1000 }); visit(); return { success: true, observation: await observe(page, log) }; };
	const locate = ref => page.locator(`[data-qase-ref="${String(ref).replace(/"/g, '')}"]`).first();
	const tools = [
		tool(`${prefix}_open`, `Open a page of the product under test (same site only) and read its text, links and interactive elements. Elements are listed with refs (e0, e1…) for ${prefix}_click/${prefix}_type.`,
			{ url: { type: 'string' } }, ['url'], async ({ url }) => {
				await ensure();
				const target = new URL(String(url), page.url() === 'about:blank' ? state.targetUrl : page.url()).href;
				if (!browser.inScope(target)) return { success: false, error: 'That URL is outside the product under test. Only pages of the same site can be opened.' };
				await browser.goto(page, target, log);
				return after();
			}),
		tool(`${prefix}_click`, 'Click an element by its ref from the latest observation. Destructive actions (delete, pay, sign out…) are refused; form submissions are blocked by the host.',
			{ ref: { type: 'string' } }, ['ref'], async ({ ref }) => {
				await ensure();
				const label = await locate(ref).evaluate(element => (element.getAttribute('aria-label') || element.innerText || element.value || '').trim().slice(0, 60)).catch(() => '');
				if (DESTRUCTIVE.test(label)) return { success: false, error: `Refused: "${label}" looks destructive.` };
				await browser.interact(() => (browser.activate ? browser.activate(locate(ref), { timeout: 5000 }) : locate(ref).click({ timeout: 5000 })));
				return after();
			}),
		tool(`${prefix}_type`, 'Type text into a field by ref (replaces its value). Set submit=true to press Enter. Submissions are blocked from reaching the server; you see how the page reacts.',
			{ ref: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, ['ref', 'text'], async input => {
				await ensure();
				await browser.interact(async () => {
					await locate(input.ref).fill(String(input.text ?? '').slice(0, 500), { timeout: 5000 });
					if (input.submit) await locate(input.ref).press('Enter');
				});
				return after();
			}),
		tool(`${prefix}_scroll`, 'Scroll the current page.', { direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'] } }, ['direction'], async ({ direction }) => {
			await ensure();
			await page.evaluate(where => { if (where === 'top') scrollTo(0, 0); else if (where === 'bottom') scrollTo(0, document.documentElement.scrollHeight); else scrollBy(0, (where === 'up' ? -1 : 1) * innerHeight * 0.8); }, direction).catch(() => {});
			return after();
		}),
		tool(`${prefix}_press`, 'Press a key (Tab, Enter, Escape, ArrowDown…) — useful for keyboard-accessibility checks.', { key: { type: 'string' } }, ['key'], async ({ key }) => {
			await ensure();
			await browser.interact(() => page.keyboard.press(String(key).slice(0, 30)));
			const focus = await page.evaluate(() => { const element = document.activeElement; if (!element || element === document.body) return 'nothing focused'; const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return `${element.tagName.toLowerCase()} "${(element.getAttribute('aria-label') || element.innerText || element.value || '').trim().slice(0, 50)}" focus outline: ${s.outlineStyle !== 'none' && s.outlineWidth !== '0px' ? 'visible' : s.boxShadow !== 'none' ? 'box-shadow' : 'none'}, on screen: ${r.bottom > 0 && r.top < innerHeight}`; }).catch(() => 'unknown');
			const result = await after();
			return { ...result, focused: focus };
		})
	];
	return { tools, close: async () => { await page?.close().catch(() => {}); } };
}

export function recordProductTool(state) {
	return tool('sqa_record_product', `Record what kind of product this is. Base every field on what the pages show and cite the evidence. Categories: ${Object.entries(PRODUCT_CATEGORIES).map(([id, label]) => `${id} = ${label}`).join('; ')}.`, {
		name: { type: 'string', description: 'Product or company name as shown.' },
		category: { type: 'string', enum: Object.keys(PRODUCT_CATEGORIES) },
		subcategory: { type: 'string', description: 'Specific type, e.g. "online course marketplace", "K-12 school LMS".' },
		summary: { type: 'string', description: 'Two or three sentences: what it does and for whom.' },
		audience: { type: 'object', properties: { description: { type: 'string' }, children: { type: 'boolean', description: 'Used by or directed at children under 18.' }, students: { type: 'boolean' }, businesses: { type: 'boolean' } }, required: ['description'] },
		regions: { type: 'array', items: { type: 'string' }, description: 'Countries/regions it serves, from language, currency, addresses, phone formats, stated markets. Empty if unknown.' },
		data_handled: { type: 'array', items: { type: 'string', enum: DATA_TYPES } },
		features: { type: 'array', items: { type: 'string' }, description: 'Relevant features: sign-up, payments, video lessons, AI tutor, forums, file upload…' },
		evidence: { type: 'array', items: { type: 'string' }, description: 'Each item: "<page path>: what it shows".' }
	}, ['name', 'category', 'summary', 'audience', 'evidence'], async input => {
		if (!PRODUCT_CATEGORIES[input.category]) return { success: false, error: `category must be one of: ${Object.keys(PRODUCT_CATEGORIES).join(', ')}` };
		const evidence = list(input.evidence, 12, 400);
		if (!evidence.length) return { success: false, error: 'Cite at least one page as evidence.' };
		state.product = {
			name: text(input.name, 120), category: input.category, subcategory: text(input.subcategory, 160), summary: text(input.summary, 800),
			audience: { description: text(input.audience?.description, 300), children: input.audience?.children === true, students: input.audience?.students === true, businesses: input.audience?.businesses === true },
			regions: list(input.regions, 12, 60), dataHandled: list(input.data_handled, 12, 40).filter(item => DATA_TYPES.includes(item)), features: list(input.features, 15, 80), evidence
		};
		return { success: true, recorded: state.product.name, next: 'The product profile is saved.' };
	});
}

export function selectFrameworksTool(state) {
	return tool('sqa_select_frameworks', 'Record the compliance standards, laws and frameworks that apply to this product, after researching them with web_search/web_fetch. Each source_url must be an official page you found in this research (search result or fetched page). Choose 3–8, most important first.', {
		frameworks: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', properties: {
			name: { type: 'string', description: 'e.g. "WCAG 2.2 Level AA", "COPPA", "India DPDP Act 2023".' },
			publisher: { type: 'string' }, version: { type: 'string' },
			source_url: { type: 'string', description: 'Official URL found in your research.' },
			kind: { type: 'string', enum: ['accessibility', 'privacy', 'security', 'consumer', 'sector', 'ai', 'other'] },
			jurisdiction: { type: 'string' },
			applicability: { type: 'string', description: 'Why it applies to THIS product (cite the product facts).' },
			mandatory: { type: 'boolean', description: 'true = legally required for this product; false = recommended standard/best practice.' }
		}, required: ['name', 'source_url', 'applicability', 'mandatory'] } }
	}, ['frameworks'], async ({ frameworks }) => {
		const seenHosts = new Set(state.sources.map(source => hostOf(source.url)));
		const accepted = [];
		const rejected = [];
		for (const item of (Array.isArray(frameworks) ? frameworks : []).slice(0, 8)) {
			const url = text(item?.source_url, 500);
			let valid = false;
			try { valid = ['https:', 'http:'].includes(new URL(url).protocol); } catch { /* invalid */ }
			if (!valid || !text(item?.name)) { rejected.push(`${text(item?.name, 80) || '(no name)'}: invalid source_url`); continue; }
			if (!state.sources.some(source => source.url === url) && !seenHosts.has(hostOf(url))) { rejected.push(`${text(item.name, 80)}: ${url} was not found in your research — search for its official page first`); continue; }
			accepted.push({ id: `F${accepted.length + 1}`, name: text(item.name, 160), publisher: text(item.publisher, 120), version: text(item.version, 60), url, kind: item.kind ?? 'other', jurisdiction: text(item.jurisdiction, 80), applicability: text(item.applicability, 600), mandatory: item.mandatory === true, baseline: false });
		}
		if (!accepted.length) return { success: false, error: `No framework accepted. ${rejected.join('; ')}` };
		state.frameworks = accepted;
		return { success: true, accepted: accepted.map(item => `${item.id} ${item.name}`), rejected };
	});
}

export function defineRequirementsTool(state) {
	return tool('sqa_define_requirements', `Record the testable requirements of ONE framework. Call once per framework. For each: the clause, what must be true, and how it can be checked from outside: "automated" (decided by the host's measured evidence — set evidence_kinds), "browser" (you will check it by using the product) or "document" (needs internal documents, e.g. a DPA, a policy, audit logs). Measured evidence kinds: ${Object.entries(EVIDENCE_KINDS).map(([id, label]) => `${id} (${label})`).join('; ')}.`, {
		framework_id: { type: 'string', description: 'F1, F2… from sqa_select_frameworks.' },
		requirements: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', properties: {
			clause: { type: 'string', description: 'Article, section or success-criterion number.' },
			title: { type: 'string' }, check: { type: 'string', description: 'What exactly to verify on this product.' },
			method: { type: 'string', enum: METHODS }, evidence_kinds: { type: 'array', items: { type: 'string', enum: Object.keys(EVIDENCE_KINDS) } },
			severity: { type: 'string', enum: SEVERITIES, description: 'Impact if not met.' }
		}, required: ['clause', 'title', 'check', 'method', 'severity'] } }
	}, ['framework_id', 'requirements'], async ({ framework_id: frameworkId, requirements }) => {
		const framework = state.frameworks.find(item => item.id === frameworkId);
		if (!framework) return { success: false, error: `Unknown framework_id. Use one of: ${state.frameworks.map(item => item.id).join(', ')}` };
		state.requirements = state.requirements.filter(item => item.frameworkId !== frameworkId);
		const added = [];
		for (const item of (Array.isArray(requirements) ? requirements : []).slice(0, 12)) {
			if (state.requirements.length >= 72) break;
			if (!text(item?.title) || !text(item?.check)) continue;
			const kinds = list(item.evidence_kinds, 6, 60).filter(kind => EVIDENCE_KINDS[kind]);
			const method = METHODS.includes(item.method) ? item.method : 'browser';
			added.push({ frameworkId, clause: text(item.clause, 80), title: text(item.title, 200), check: text(item.check, 600), method: method === 'automated' && !kinds.length ? 'browser' : method, evidenceKinds: kinds, severity: SEVERITIES.includes(item.severity) ? item.severity : 'medium' });
		}
		if (!added.length) return { success: false, error: 'No valid requirement (each needs a title and a check).' };
		state.requirements.push(...added);
		renumber(state);
		return { success: true, framework: framework.name, requirements: state.requirements.filter(item => item.frameworkId === frameworkId).map(item => `${item.id} ${item.title}`) };
	});
}

export function renumber(state) {
	state.requirements.forEach((item, index) => { item.id = `R${index + 1}`; item.status ??= 'untested'; });
}

export function recordResultTool(state) {
	return tool('sqa_record_result', 'Record the outcome of one requirement. pass = verified as met; fail = verified as not met; partial = partly met; needs_documents = cannot be verified from outside; not_applicable = does not apply after all. fail/partial need what you observed and a concrete fix. Cite evidence ids (E…) and/or the page you checked.', {
		requirement_id: { type: 'string' }, status: { type: 'string', enum: RESULT_STATUSES },
		observed: { type: 'string', description: 'What you saw, specifically (text, element, behaviour).' },
		url: { type: 'string', description: 'The page where it was checked.' },
		evidence_ids: { type: 'array', items: { type: 'string' } },
		fix: { type: 'string', description: 'For fail/partial: what to change, specifically.' }
	}, ['requirement_id', 'status', 'observed'], async input => {
		const requirement = state.requirements.find(item => item.id === input.requirement_id);
		if (!requirement) return { success: false, error: 'Unknown requirement_id.' };
		if (!RESULT_STATUSES.includes(input.status)) return { success: false, error: `status must be one of ${RESULT_STATUSES.join(', ')}` };
		const evidenceIds = list(input.evidence_ids, 8, 10).filter(id => state.evidence.some(item => item.id === id));
		const observed = text(input.observed, 1200);
		if (['fail', 'partial'].includes(input.status) && (!observed || !text(input.fix))) return { success: false, error: 'fail and partial results need what you observed and a concrete fix.' };
		if (input.status === 'pass' && !evidenceIds.length && !text(input.url)) return { success: false, error: 'A pass needs evidence: cite evidence ids or the page you checked.' };
		Object.assign(requirement, { status: input.status, observed, url: text(input.url, 500) || undefined, evidenceIds, fix: text(input.fix, 1000) || undefined, decidedBy: 'agent' });
		const remaining = state.requirements.filter(item => item.status === 'untested').map(item => item.id);
		return { success: true, recorded: requirement.id, remaining: remaining.slice(0, 30), remaining_count: remaining.length };
	});
}

export function finishTool(state) {
	return tool('sqa_finish', 'Finish the assessment with an executive summary for the product owner.', {
		summary: { type: 'string', description: '4–6 sentences: product, standards assessed, overall compliance posture, the most serious gaps.' },
		priorities: { type: 'array', items: { type: 'string' }, description: 'Top fixes in priority order (max 6).' }
	}, ['summary'], async input => {
		if (!text(input.summary)) return { success: false, error: 'summary is required.' };
		state.summary = { text: text(input.summary, 2000), priorities: list(input.priorities, 6, 400) };
		return { success: true };
	});
}
