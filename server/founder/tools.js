/**
 * Recording tools for the Founder review. They validate the agent's structured
 * output and write it into session.founder; the host — not the model —
 * computes the readiness score, the verdict and the priority order.
 *
 * Every judgement must cite evidence the host can show: measured signals
 * (S1…), walked journeys (J1…) or researched competitors (C1…). A competitor
 * is accepted only when its source was found in this run's research.
 */
import { LENS_IDS, PRODUCT_CATEGORIES } from './catalog.js';

const text = (value, max = 2000) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const list = (value, max = 20, length = 400) => (Array.isArray(value) ? value : []).map(item => text(item, length)).filter(Boolean).slice(0, max);
const oneOf = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
const hostOf = url => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } };
const httpUrl = value => { try { const url = new URL(String(value)); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; } };
const tool = (name, description, properties, required, run) => ({ name, category: 'founder', description, parametersSchema: { type: 'object', properties, required }, run });

export const BUSINESS_MODELS = ['free', 'freemium', 'free_trial', 'subscription', 'one_time', 'usage_based', 'marketplace', 'advertising', 'enterprise_sales', 'services', 'unknown'];
export const PRIMARY_GOALS = ['sign_up', 'purchase', 'book_demo', 'lead', 'download', 'subscribe', 'engagement', 'other'];
export const STAGES = ['idea', 'pre_launch', 'early', 'growth', 'unknown'];
export const PRIORITIES = ['now', 'next', 'later'];
export const IMPACTS = ['high', 'medium', 'low'];
export const EFFORTS = ['small', 'medium', 'large'];
export const OUTCOMES = ['completed', 'partial', 'blocked', 'not_attempted'];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];

/** Ids an evidence reference may use. */
export function knownEvidence(state) {
	return new Set([...(state.signals ?? []).map(item => item.id), ...(state.journeys ?? []).map(item => item.id), ...(state.market?.competitors ?? []).map(item => item.id)]);
}
const cite = (state, ids) => { const known = knownEvidence(state); return [...new Set(list(ids, 12, 20).map(id => id.toUpperCase()))].filter(id => known.has(id)); };

export function recordBusinessTool(state) {
	return tool('founder_record_business', 'Record what the product is and how it intends to make money and win users. Call once.', {
		name: { type: 'string' }, category: { type: 'string', enum: Object.keys(PRODUCT_CATEGORIES) },
		one_liner: { type: 'string', description: 'What the product does, in plain words.' },
		value_proposition: { type: 'string', description: 'The promise the site makes to visitors, as stated (quote the headline if it is the promise).' },
		target_customer: { type: 'object', properties: { stated: { type: 'string', description: 'Who the site says it is for (empty if not stated).' }, inferred: { type: 'string', description: 'Who it is realistically for.' } } },
		business_model: { type: 'string', enum: BUSINESS_MODELS }, primary_goal: { type: 'string', enum: PRIMARY_GOALS, description: 'The main action the site wants a visitor to take.' },
		stage: { type: 'string', enum: STAGES },
		journeys: { type: 'array', description: '3–6 key user journeys to walk, most important first.', items: { type: 'object', properties: { name: { type: 'string' }, goal: { type: 'string', description: 'What the user wants to achieve.' }, start_url: { type: 'string' } }, required: ['name', 'goal'] } },
		evidence: { type: 'array', items: { type: 'string' }, description: 'Page observations behind these conclusions ("/pricing: ...").' }
	}, ['name', 'category', 'one_liner', 'target_customer', 'business_model', 'primary_goal', 'journeys', 'evidence'], async input => {
		if (!PRODUCT_CATEGORIES[input.category]) return { success: false, error: `category must be one of: ${Object.keys(PRODUCT_CATEGORIES).join(', ')}` };
		const evidence = list(input.evidence, 12);
		if (!evidence.length) return { success: false, error: 'Cite at least one page observation in evidence.' };
		const proposed = (Array.isArray(input.journeys) ? input.journeys : []).map(item => ({ name: text(item?.name, 120), goal: text(item?.goal, 300), startUrl: httpUrl(item?.start_url) })).filter(item => item.name && item.goal);
		// The owner's journeys always come first and are never dropped.
		const owner = (state.brief?.journeys ?? []).map(name => ({ name: text(name, 120), goal: text(name, 300), requestedBy: 'owner' }));
		const merged = [...owner, ...proposed.filter(item => !owner.some(entry => entry.name.toLowerCase() === item.name.toLowerCase()))].slice(0, 6);
		if (!merged.length) return { success: false, error: 'Propose at least one journey to walk.' };
		state.business = {
			name: text(input.name, 120), category: input.category, oneLiner: text(input.one_liner, 400), valueProposition: text(input.value_proposition, 400),
			targetCustomer: { stated: text(input.target_customer?.stated, 300), inferred: text(input.target_customer?.inferred, 300) },
			businessModel: oneOf(input.business_model, BUSINESS_MODELS, 'unknown'), primaryGoal: oneOf(input.primary_goal, PRIMARY_GOALS, 'other'), stage: oneOf(input.stage, STAGES, 'unknown'),
			evidence
		};
		state.journeyPlan = merged.map((item, index) => ({ id: `J${index + 1}`, ...item }));
		return { success: true, journeys: state.journeyPlan.map(item => `${item.id}: ${item.name}`) };
	});
}

export function recordMarketTool(state) {
	return tool('founder_record_market', 'Record the competitive landscape found with web_search/web_fetch: direct competitors and what users in this category expect. Call once.', {
		competitors: { type: 'array', description: '2–6 direct competitors or alternatives users would compare against.', items: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string' }, positioning: { type: 'string', description: 'How they pitch themselves.' }, pricing: { type: 'string', description: 'Their pricing, if found.' }, strengths: { type: 'array', items: { type: 'string' } }, source_url: { type: 'string', description: 'Where you found this (a search result or page you read).' } }, required: ['name', 'url', 'positioning', 'source_url'] } },
		expectations: { type: 'array', items: { type: 'string' }, description: 'What users expect from a product of this type today (free trial, integrations, mobile app…).' },
		differentiation: { type: 'array', items: { type: 'string' }, description: 'What could make this product stand out against them.' },
		none_found: { type: 'string', description: 'Only if no competitor could be found: why.' }
	}, ['competitors', 'expectations'], async input => {
		const sources = new Set((state.sources ?? []).map(source => source.url));
		const sourceHosts = new Set((state.sources ?? []).map(source => hostOf(source.url)));
		const own = hostOf(state.targetUrl);
		const accepted = [], rejected = [];
		for (const item of Array.isArray(input.competitors) ? input.competitors.slice(0, 8) : []) {
			const url = httpUrl(item?.url), source = httpUrl(item?.source_url);
			const found = source && (sources.has(source) || sourceHosts.has(hostOf(source)));
			if (!url || !text(item?.name) || !found || hostOf(url) === own) { rejected.push(`${text(item?.name, 60) || '(unnamed)'}: ${!url ? 'invalid url' : hostOf(url) === own ? 'that is this product' : 'its source was not found in this research'}`); continue; }
			accepted.push({ id: `C${accepted.length + 1}`, name: text(item.name, 120), url, positioning: text(item.positioning, 400), pricing: text(item.pricing, 300), strengths: list(item.strengths, 6, 200), source });
		}
		if (!accepted.length && !text(input.none_found)) return { success: false, error: `No competitor was accepted${rejected.length ? ` (${rejected.join('; ')})` : ''}. Cite competitors you actually found with web_search, or set none_found.`, rejected };
		state.market = { competitors: accepted, expectations: list(input.expectations, 10, 300), differentiation: list(input.differentiation, 8, 300), noneFound: accepted.length ? undefined : text(input.none_found, 300) };
		return { success: true, accepted: accepted.map(item => `${item.id}: ${item.name}`), rejected };
	});
}

export function recordJourneyTool(state) {
	return tool('founder_record_journey', 'Record the outcome of one walked journey as the target customer would experience it.', {
		journey_id: { type: 'string' }, outcome: { type: 'string', enum: OUTCOMES },
		steps: { type: 'array', items: { type: 'string' }, description: 'What you did and saw, in order.' },
		friction: { type: 'array', items: { type: 'object', properties: { issue: { type: 'string' }, severity: { type: 'string', enum: SEVERITIES }, page: { type: 'string' }, impact: { type: 'string', description: 'What it costs the business (drop-off, lost trust…).' } }, required: ['issue', 'severity'] } },
		delights: { type: 'array', items: { type: 'string' }, description: 'What worked well.' },
		summary: { type: 'string' }
	}, ['journey_id', 'outcome', 'steps', 'summary'], async input => {
		const plan = (state.journeyPlan ?? []).find(item => item.id === String(input.journey_id).toUpperCase());
		if (!plan) return { success: false, error: `Unknown journey id. Planned: ${(state.journeyPlan ?? []).map(item => item.id).join(', ')}` };
		if (!OUTCOMES.includes(input.outcome)) return { success: false, error: `outcome must be one of ${OUTCOMES.join(', ')}` };
		const steps = list(input.steps, 25, 300);
		if (!steps.length && input.outcome !== 'not_attempted') return { success: false, error: 'List the steps you took.' };
		const entry = { ...plan, outcome: input.outcome, steps, friction: (Array.isArray(input.friction) ? input.friction : []).slice(0, 10).map(item => ({ issue: text(item?.issue, 300), severity: oneOf(item?.severity, SEVERITIES, 'medium'), page: text(item?.page, 300), impact: text(item?.impact, 300) })).filter(item => item.issue), delights: list(input.delights, 6, 200), summary: text(input.summary, 600) };
		state.journeys = [...(state.journeys ?? []).filter(item => item.id !== plan.id), entry].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
		return { success: true, remaining: (state.journeyPlan ?? []).filter(item => !state.journeys.some(done => done.id === item.id)).map(item => item.id) };
	});
}

export function scoreLensTool(state) {
	return tool('founder_score_lens', 'Score one business lens from 0 to 10 with the evidence behind it. Call once per lens.', {
		lens: { type: 'string', enum: LENS_IDS }, score: { type: 'number', description: '0–10. 9–10 best in class, 7–8 good, 5–6 average, 3–4 weak, 0–2 missing.' },
		verdict: { type: 'string', description: 'One sentence a founder would understand.' },
		strengths: { type: 'array', items: { type: 'string' } }, weaknesses: { type: 'array', items: { type: 'string' } },
		evidence: { type: 'array', items: { type: 'string' }, description: 'Ids of signals (S…), journeys (J…) or competitors (C…).' }
	}, ['lens', 'score', 'verdict', 'evidence'], async input => {
		if (!LENS_IDS.includes(input.lens)) return { success: false, error: `lens must be one of ${LENS_IDS.join(', ')}` };
		const score = Number(input.score);
		if (!Number.isFinite(score) || score < 0 || score > 10) return { success: false, error: 'score must be a number from 0 to 10.' };
		const evidence = cite(state, input.evidence);
		if (!evidence.length) return { success: false, error: `Cite at least one known evidence id (S…, J… or C…). Known: ${[...knownEvidence(state)].slice(0, 40).join(', ')}` };
		state.lenses = { ...(state.lenses ?? {}), [input.lens]: { score: Math.round(score * 10) / 10, verdict: text(input.verdict, 300), strengths: list(input.strengths, 6, 240), weaknesses: list(input.weaknesses, 6, 240), evidence, scoredBy: 'agent' } };
		return { success: true, remaining: LENS_IDS.filter(id => !state.lenses[id]) };
	});
}

export function recordRecommendationsTool(state) {
	return tool('founder_record_recommendations', 'Record the advice: what to do (and what to stop or avoid) to make the product polished and attractive to users, plus what is working and should be kept.', {
		recommendations: { type: 'array', description: '6–15 recommendations, the most valuable first.', items: { type: 'object', properties: {
			title: { type: 'string', description: 'Imperative, specific: "Replace the hero headline with the outcome customers get".' },
			lens: { type: 'string', enum: LENS_IDS }, kind: { type: 'string', enum: ['do', 'avoid'], description: 'do = change or add; avoid = stop doing or never do.' },
			priority: { type: 'string', enum: PRIORITIES }, impact: { type: 'string', enum: IMPACTS }, effort: { type: 'string', enum: EFFORTS },
			why: { type: 'string', description: 'The business reason: what it costs now, what it will gain. Refer to the evidence and competitors.' },
			how: { type: 'array', items: { type: 'string' }, description: 'Concrete steps to implement it.' },
			metric: { type: 'string', description: 'The number that should move (e.g. visitor-to-sign-up rate).' },
			acceptance: { type: 'array', items: { type: 'string' }, description: 'How to know it is done.' },
			evidence: { type: 'array', items: { type: 'string' } }
		}, required: ['title', 'lens', 'kind', 'priority', 'impact', 'effort', 'why', 'how', 'evidence'] } },
		keep: { type: 'array', description: 'What already works and should be kept (1–5).', items: { type: 'object', properties: { title: { type: 'string' }, why: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } }, required: ['title', 'why'] } }
	}, ['recommendations'], async input => {
		const accepted = [], rejected = [];
		for (const item of Array.isArray(input.recommendations) ? input.recommendations.slice(0, 20) : []) {
			const evidence = cite(state, item?.evidence);
			const entry = { title: text(item?.title, 200), lens: oneOf(item?.lens, LENS_IDS, undefined), kind: item?.kind === 'avoid' ? 'avoid' : 'do', priority: oneOf(item?.priority, PRIORITIES, 'next'), impact: oneOf(item?.impact, IMPACTS, 'medium'), effort: oneOf(item?.effort, EFFORTS, 'medium'), why: text(item?.why, 1200), how: list(item?.how, 8, 400), metric: text(item?.metric, 200), acceptance: list(item?.acceptance, 6, 300), evidence, source: 'agent' };
			if (!entry.title || !entry.lens || !entry.why) { rejected.push(`${entry.title || '(untitled)'}: needs a title, a lens and why`); continue; }
			if (!entry.how.length) { rejected.push(`${entry.title}: needs concrete steps in how`); continue; }
			if (entry.priority === 'now' && !evidence.length) { rejected.push(`${entry.title}: a "now" priority needs evidence ids`); continue; }
			accepted.push(entry);
		}
		if (accepted.length < 3) return { success: false, error: `Only ${accepted.length} recommendations were valid; record at least 3.${rejected.length ? ` Rejected: ${rejected.join('; ')}` : ''}`, rejected };
		state.recommendations = accepted;
		state.keep = (Array.isArray(input.keep) ? input.keep : []).slice(0, 6).map(item => ({ title: text(item?.title, 200), why: text(item?.why, 500), evidence: cite(state, item?.evidence) })).filter(item => item.title);
		return { success: true, accepted: accepted.length, rejected };
	});
}

export function finishTool(state) {
	return tool('founder_finish', 'Write the executive summary for the founder and finish the review.', {
		summary: { type: 'string', description: '3–5 sentences: where the product stands with users, the biggest risk and the biggest opportunity.' },
		positioning: { type: 'string', description: 'A suggested one-line positioning statement: "<product> helps <customer> <outcome>, unlike <alternative>".' },
		headline_options: { type: 'array', items: { type: 'string' }, description: '2–3 sharper hero headline options.' }
	}, ['summary'], async input => {
		const summary = text(input.summary, 1500);
		if (!summary) return { success: false, error: 'summary is required.' };
		state.summary = summary;
		state.positioning = text(input.positioning, 300) || undefined;
		state.headlineOptions = list(input.headline_options, 3, 140);
		return { success: true };
	});
}
