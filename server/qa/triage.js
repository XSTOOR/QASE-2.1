/**
 * Triage: merge duplicates, verify candidates with JEV (or the reasoner when
 * JEV is unavailable), grade severity, and decide what becomes a finding.
 *
 * Decision rule (documented in docs/QA-ENGINE.md):
 *   detector candidates: score = 0.35·detector confidence + 0.65·verifier probability
 *                        (a verifier that is confident it is a false positive can dismiss it)
 *   model candidates:    score = verifier probability (or 0.85·own confidence unverified)
 *   promote when score ≥ 0.5. Without any verifier, detector confidence alone decides.
 * Nothing in triage can fail the run: if both models are down, the deterministic
 * confidences are used and the report says verification was unavailable.
 */
import { UNTRUSTED_CONTENT_RULE } from '../untrustedContent.js';
import { mergeCandidates, SEVERITIES, severityRank } from './findings.js';

const SEVERITY_SCALE = ['info', 'low', 'medium', 'high', 'critical'];
const BATCH = 15;

/** What the verifier must know about how QASE tests, so harness side-effects are not reported. */
export const HARNESS_NOTE = 'How QASE tests: it uses a real browser but blocks every write request (POST/PUT/PATCH/DELETE, form submissions) and every navigation to another website (including "Sign in with Google/GitHub" and other SSO hand-offs), unless the owner allowed it. Errors, spinners, "Failed to fetch"/network-error messages or stuck loading states that appear right after submitting a form or clicking a sign-in-with button are caused by this block, not by the site. Fake test values typed into forms are QASE\'s own input.';

const SEVERITY_RUBRIC = [
	'info: no user impact (best-practice note, e.g. missing security.txt)',
	'low: cosmetic or minor (small touch targets, minor contrast shortfall, missing Referrer-Policy, a console warning with no visible effect)',
	'medium: a real but survivable problem (unlabelled form fields, low contrast on body text, disabled pinch-zoom, missing CSP/HSTS/clickjacking protection, a console error, a confusing validation message)',
	'high: breaks an important flow or blocks a group of users (control that cannot be clicked, content unreadable or hidden, a broken page or API, keyboard trap, reflected XSS without exploit proof)',
	'critical: the core flow is blocked for everyone, data is exposed (secrets, personal data) or a vulnerability is exploitable'
];

function summary(item) {
	return [
		`Title: ${item.title}`,
		`Category: ${item.category}; proposed severity: ${item.severity}; source: ${item.source === 'detector' ? `automated check ${item.detector}` : item.source === 'visual' ? 'visual review of a screenshot' : 'exploratory test by an AI tester'}`,
		`Page: ${item.url}${item.viewports?.length ? `; viewports: ${item.viewports.join(', ')}` : ''}${item.selector ? `; element: ${item.selector}` : ''}`,
		`Observed: ${item.actual}`,
		`Expected: ${item.expected}`,
		item.evidence ? `Evidence: ${item.evidence.slice(0, 600)}` : '',
		item.steps?.length ? `Steps: ${item.steps.join(' → ')}` : '',
		item.urls?.length > 1 ? `Seen on ${item.urls.length} pages` : '',
		item.data?.harness ? `Harness note: ${item.data.harness}` : ''
	].filter(Boolean).join('\n').slice(0, 3500);
}

async function verifyWithJev(models, batch, context, signal) {
	const questions = {};
	batch.forEach((item, index) => {
		questions[`g${index}`] = { type: 'noul', instructions: `Is this a genuine defect that real users of the website would hit? Give the probability that it is real and user-impacting. Answer low for: false positives of automated tooling, intentional design (e.g. an icon button placed inside a field), and side-effects of the test harness.\n${HARNESS_NOTE}\n\n${summary(item)}` };
		questions[`s${index}`] = { type: 'score', instructions: `Rate the user impact of this defect using the criteria. Be conservative: most automated accessibility and header findings are medium or low.\n\n${summary(item)}`, criteria: SEVERITY_RUBRIC };
	});
	const answers = await models.decide({ task: 'QA defect triage', target: context.target, pages: context.pages, viewports: context.viewports, harness: HARNESS_NOTE, blockedDuringRun: context.blocked }, questions, { signal });
	if (!answers) return undefined;
	return batch.map((_, index) => ({
		probability: answers[`g${index}`]?.noul,
		severity: Number.isFinite(answers[`s${index}`]?.score) ? SEVERITY_SCALE[Math.max(0, Math.min(4, Math.round(answers[`s${index}`].score)))] : undefined
	}));
}

async function verifyWithReasoner(models, batch, context, signal, purpose = 'triage') {
	const result = await models.json([
		{ role: 'system', content: `You triage automated QA results for a website. For each candidate decide how likely it is a genuine, user-impacting defect (0–1) and its severity. ${HARNESS_NOTE}\nSeverity scale:\n${SEVERITY_RUBRIC.join('\n')}\nAnswer JSON only: {"results":[{"index":0,"probability":0.0,"severity":"medium","reason":"one sentence"}]}\n${UNTRUSTED_CONTENT_RULE}` },
		{ role: 'user', content: `Site: ${context.target}\n\n${batch.map((item, index) => `### Candidate ${index}\n${summary(item)}`).join('\n\n')}` }
	], { maxTokens: 3000, signal, purpose });
	if (!Array.isArray(result?.results)) return undefined;
	return batch.map((_, index) => {
		const entry = result.results.find(item => Number(item?.index) === index);
		const probability = Number(entry?.probability);
		return { probability: Number.isFinite(probability) ? Math.max(0, Math.min(1, probability)) : undefined, severity: SEVERITIES.includes(entry?.severity) ? entry.severity : undefined, reason: entry?.reason };
	});
}

export async function triage({ candidates, models, context, signal, deadline = Infinity, log = () => {}, onDecision = () => {}, escalationBand = [0.35, 0.65] }) {
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
	// Escalation: JEV verdicts in the uncertain band get a second opinion from the reasoner,
	// which decides. Logged so the report can show which model settled each case.
	const uncertain = queue.filter(item => item.verification?.by === 'jev' && item.verification.probability >= escalationBand[0] && item.verification.probability <= escalationBand[1]).slice(0, 30);
	stats.escalated = 0;
	if (uncertain.length && models.reasonerAvailable() && Date.now() < deadline) {
		for (let start = 0; start < uncertain.length; start += BATCH) {
			const batch = uncertain.slice(start, start + BATCH);
			const verdicts = await verifyWithReasoner(models, batch, context, signal, 'escalation');
			onDecision({ task: 'escalation', model: verdicts ? 'reasoner' : 'none', reason: `${batch.length} JEV verdict(s) between ${escalationBand[0]} and ${escalationBand[1]}`, outcome: verdicts ? 'reasoner decided' : 'reasoner unavailable; JEV verdict kept' });
			if (!verdicts) break;
			stats.verifiedBy.add('reasoner');
			batch.forEach((item, index) => {
				const verdict = verdicts[index];
				if (verdict?.probability === undefined) return;
				item.verification = { probability: verdict.probability, severity: verdict.severity ?? item.verification.severity, by: 'reasoner', reason: verdict.reason, escalatedFrom: { by: 'jev', probability: item.verification.probability } };
				stats.escalated++;
			});
		}
	} else if (uncertain.length) {
		onDecision({ task: 'escalation', model: 'none', reason: `${uncertain.length} uncertain JEV verdict(s); reasoner unavailable`, outcome: 'JEV verdict kept', fallback: true });
	}
	const promoted = [];
	const dismissed = [];
	for (const item of merged) {
		const verification = item.verification;
		let score;
		if (verification) score = item.source === 'detector' ? 0.35 * item.confidence + 0.65 * verification.probability : verification.probability;
		else { stats.unverified++; score = item.source === 'detector' ? item.confidence : 0.85 * item.confidence; }
		item.score = Math.round(score * 100) / 100;
		if (verification?.severity) {
			const proposed = SEVERITY_SCALE.indexOf(item.severity), graded = SEVERITY_SCALE.indexOf(verification.severity);
			// Model-sourced items take the verifier's grade. A detector's severity comes from a
			// measured rule: the verifier may lower it one step, or raise it one step only when it
			// rates the impact at least two steps higher.
			if (item.source !== 'detector') item.severity = verification.severity;
			else if (graded < proposed || graded - proposed >= 2) item.severity = SEVERITY_SCALE[proposed + Math.sign(graded - proposed)];
		}
		(score >= 0.5 ? promoted : dismissed).push(item);
	}
	return { findings: promoted, dismissed, stats: { ...stats, verifiedBy: [...stats.verifiedBy] } };
}
