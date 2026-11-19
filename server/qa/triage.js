/**
 * Triage: merge duplicates, verify candidates with JEV (or the reasoner when
 * JEV is unavailable), grade severity, and decide what becomes a finding.
 *
 * Decision rule (documented in docs/QA-ENGINE.md):
 *   detector candidates: score = 0.6·detector confidence + 0.4·verifier probability
 *   model candidates:    score = verifier probability (or 0.85·own confidence unverified)
 *   promote when score ≥ 0.5. Without any verifier, detector confidence alone decides.
 * Nothing in triage can fail the run: if both models are down, the deterministic
 * confidences are used and the report says verification was unavailable.
 */
import { mergeCandidates, SEVERITIES, severityRank } from './findings.js';

const SEVERITY_SCALE = ['info', 'low', 'medium', 'high', 'critical'];
const BATCH = 20;

function summary(item) {
	return [
		`Title: ${item.title}`,
		`Category: ${item.category}; proposed severity: ${item.severity}; source: ${item.source === 'detector' ? `automated check ${item.detector}` : item.source === 'visual' ? 'visual review of a screenshot' : 'exploratory test by an AI tester'}`,
		`Page: ${item.url}${item.viewports?.length ? `; viewports: ${item.viewports.join(', ')}` : ''}${item.selector ? `; element: ${item.selector}` : ''}`,
		`Observed: ${item.actual}`,
		`Expected: ${item.expected}`,
		item.evidence ? `Evidence: ${item.evidence.slice(0, 600)}` : '',
		item.steps?.length ? `Steps: ${item.steps.join(' → ')}` : ''
	].filter(Boolean).join('\n').slice(0, 3500);
}

async function verifyWithJev(models, batch, context, signal) {
	const questions = {};
	batch.forEach((item, index) => {
		questions[`g${index}`] = { type: 'noul', instructions: `Is this a genuine defect that affects real users of the website under test? Answer the probability it is real and user-impacting (not a false positive of automated tooling, not intentional design, not a test-harness artifact such as blocked submissions).\n\n${summary(item)}` };
		questions[`s${index}`] = { type: 'score', instructions: `Rate the user impact of this defect.\n\n${summary(item)}`, criteria: ['info: no user impact', 'low: cosmetic or minor', 'medium: real but survivable problem', 'high: breaks an important flow, accessibility barrier or security weakness', 'critical: blocks the core flow, data exposure or exploitable vulnerability'] };
	});
	const answers = await models.decide({ task: 'QA defect triage', target: context.target, pages: context.pages, viewports: context.viewports }, questions, { signal });
	if (!answers) return undefined;
	return batch.map((_, index) => ({
		probability: answers[`g${index}`]?.noul,
		severity: Number.isFinite(answers[`s${index}`]?.score) ? SEVERITY_SCALE[Math.max(0, Math.min(4, Math.round(answers[`s${index}`].score)))] : undefined
	}));
}

async function verifyWithReasoner(models, batch, context, signal) {
	const result = await models.json([
		{ role: 'system', content: 'You triage automated QA results for a website. For each candidate decide how likely it is a genuine, user-impacting defect (0–1) and its severity (info, low, medium, high, critical). Blocked form submissions are a property of the test harness, not defects. Answer JSON only: {"results":[{"index":0,"probability":0.0,"severity":"medium","reason":"…"}]}' },
		{ role: 'user', content: `Site: ${context.target}\n\n${batch.map((item, index) => `### Candidate ${index}\n${summary(item)}`).join('\n\n')}` }
	], { maxTokens: 3000, signal, purpose: 'triage' });
	if (!Array.isArray(result?.results)) return undefined;
	return batch.map((_, index) => {
		const entry = result.results.find(item => Number(item?.index) === index);
		const probability = Number(entry?.probability);
		return { probability: Number.isFinite(probability) ? Math.max(0, Math.min(1, probability)) : undefined, severity: SEVERITIES.includes(entry?.severity) ? entry.severity : undefined, reason: entry?.reason };
	});
}

export async function triage({ candidates, models, context, signal, deadline = Infinity, log = () => {} }) {
	const merged = mergeCandidates(candidates).sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.confidence - a.confidence);
	const stats = { candidates: candidates.length, merged: merged.length, verifiedBy: new Set(), unverified: 0 };
	// High-confidence deterministic checks with exact evidence do not need a model's opinion,
	// but they still get one when there is budget, so severity can be graded.
	const queue = merged.slice(0, 120);
	for (let start = 0; start < queue.length; start += BATCH) {
		const batch = queue.slice(start, start + BATCH);
		if (Date.now() >= deadline) break;
		let verdicts;
		let by;
		if (models.jevAvailable()) {
			verdicts = await verifyWithJev(models, batch, context, signal);
			if (verdicts) by = 'jev';
		}
		if (!verdicts && models.reasonerAvailable()) {
			verdicts = await verifyWithReasoner(models, batch, context, signal);
			if (verdicts) by = 'reasoner';
		}
		if (by) stats.verifiedBy.add(by);
		if (!verdicts) { log('No verifier available for a triage batch; using deterministic confidence.'); continue; }
		batch.forEach((item, index) => {
			const verdict = verdicts[index];
			if (verdict?.probability !== undefined) item.verification = { probability: verdict.probability, severity: verdict.severity, by, reason: verdict.reason };
		});
	}
	const promoted = [];
	const dismissed = [];
	for (const item of merged) {
		const verification = item.verification;
		let score;
		if (verification) score = item.source === 'detector' ? 0.6 * item.confidence + 0.4 * verification.probability : verification.probability;
		else { stats.unverified++; score = item.source === 'detector' ? item.confidence : 0.85 * item.confidence; }
		item.score = Math.round(score * 100) / 100;
		if (verification?.severity) {
			const proposed = SEVERITY_SCALE.indexOf(item.severity), graded = SEVERITY_SCALE.indexOf(verification.severity);
			// Model-sourced items take the verifier's grade; detector items move at most one step.
			if (item.source !== 'detector') item.severity = verification.severity;
			else if (graded !== proposed) item.severity = SEVERITY_SCALE[proposed + Math.sign(graded - proposed)];
		}
		(score >= 0.5 ? promoted : dismissed).push(item);
	}
	return { findings: promoted, dismissed, stats: { ...stats, verifiedBy: [...stats.verifiedBy] } };
}
