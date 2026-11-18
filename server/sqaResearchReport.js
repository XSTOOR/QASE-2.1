import { publisherBackgroundSection } from './sqaSourceAuthority.js';
import { verifiedResearchBody } from './sqaResearchSource.js';
import { canonicalModeHash } from './modeIntegrity.js';
import { modeDiscoveryStatus, modeWorkReadiness } from './modeDiscovery.js';
import { applicabilityReviewIds } from './sqaDocumentReview.js';

// Repeated observations of the same identifiable element support one finding.
export function researchFindings(tests) {
 const findings = new Map();
 for (const test of tests) {
  for (const observation of test.observations) {
   for (const assertion of observation.assertions.filter(item=>item.outcome==='fail')) {
    let selector;
    try { selector = JSON.parse(assertion.actual)?.selector; } catch { /* Some checks return plain text. */ }
    const key = JSON.stringify([test.id, observation.url, observation.stateKey, assertion.check,
     assertion.name, assertion.expected, assertion.actual, selector && observation.url ? null : observation.evidenceId]);
    const proof = {evidenceId:observation.evidenceId,activityId:observation.activityId,at:observation.at};
    const existing = findings.get(key);
    if (existing) {
     if (!existing.evidence.some(row=>row.evidenceId===proof.evidenceId)) existing.evidence.push(proof);
     continue;
    }
    findings.set(key,{testId:test.id,requirementIds:test.requirementIds,featureIds:test.featureIds,
     evidenceId:proof.evidenceId,activityId:proof.activityId,evidence:[proof],title:assertion.name,
     expected:assertion.expected,observed:assertion.actual,url:observation.url,tool:observation.tool,
     observedAt:observation.at,method:test.method});
   }
  }
 }
 return [...findings.values()];
}

// Derive the report exclusively from run-owned records. A successful workflow
// describes a browser sample. Its assertions do not certify a whole requirement.
export function buildResearchReport(session, now = Date.now()) {
	const state = session.sqa.execution;
	const research = state.research ?? {};
	const sources = research.sources ?? [];
	const requirements = research.requirements ?? [];
	const decisions = research.applicability ?? [];
	const workflows = state.workflows ?? [];
	const discovery = modeDiscoveryStatus(session);
	const work = modeWorkReadiness(session);
	const blockers = [];
	const intact = row => {
		const { integrityHash, ...payload } = row;
		return integrityHash === canonicalModeHash(payload);
	};
	const usableSources = new Map();
	const features = new Set(discovery.features.map(feature => feature.id));
	if (!discovery.required || !discovery.ready) blockers.push('Project discovery is incomplete.');
	if (!work.ready) blockers.push('Browser exploration or workflow evidence is incomplete.');
	for (const source of sources) {
		const content = verifiedResearchBody(source, session.id);
		if (content === null) {
			blockers.push('Invalid source receipt ' + source.id);
		} else usableSources.set(source.id, { ...source, content });
	}
	for (const req of requirements) {
		const src = usableSources.get(req.sourceId);
		if (!src || !Number.isFinite(src.retrievedAt) || src.retrievedAt > now || now-src.retrievedAt > 86400000 ||
			src.contentHash !== req.contentHash || ![req.quote, req.controlId, req.framework].every(value =>
				typeof value === 'string' && value.trim() && src.content.includes(value))) blockers.push('Invalid requirement citation ' + req.id);
		if (!decisions.some(d => d.requirement_ids.includes(req.id))) blockers.push('Missing applicability decision for ' + req.id);
	}
	const hasOfficialTechnicalCitation = requirements.some(req => {
		const source = usableSources.get(req.sourceId);
		return source?.authority === 'verified_official' && source.superseded === false &&
			!publisherBackgroundSection(source, req.controlId);
	});
	if (!hasOfficialTechnicalCitation)
		blockers.push('Cite a requirement from a verified current official edition. Background material cannot qualify publication.');
	if (!requirements.length || !decisions.length) blockers.push('No assessed research requirements.');
	for (const d of decisions) {
		const linked = d.requirement_ids.map(id => requirements.find(r => r.id === id));
		if (!intact(d) || !linked.length || linked.some(r => !r) || !d.feature_ids.length ||
			d.feature_ids.some(id => !features.has(id))) {
			blockers.push('Invalid applicability decision ' + d.id);
			continue;
		}
		const reviews = applicabilityReviewIds(session, d, linked);
		if (!reviews || canonicalModeHash(reviews) !== canonicalModeHash(d.documentReviewIds ?? [])) blockers.push('Unverified organizational evidence for ' + d.id);
		if (d.classification !== 'NOT_APPLICABLE' && !workflows.some(w => w.researchLink?.decisionId === d.id)) blockers.push('Unscheduled applicability decision ' + d.id);
	}
	for (const w of workflows) {
		const link = w.researchLink;
		const decision = decisions.find(d => d.id === link?.decisionId);
		const revision = research.planRevisions?.flatMap(r => r.added).filter(row => row.workflowId === w.id);
		if (!decision || decision.integrityHash !== link.decisionHash || decision.classification === 'NOT_APPLICABLE' ||
			!w.feature_ids.every(id => decision.feature_ids.includes(id)) ||
			canonicalModeHash(link.sources) !== canonicalModeHash(decision.requirement_ids.map(id => {
				const r = requirements.find(row => row.id === id);
				return { requirementId: id, sourceId: r?.sourceId, contentHash: r?.contentHash };
			})) || revision?.length !== 1 || canonicalModeHash(revision[0].researchLink) !== canonicalModeHash(link))
			blockers.push('Invalid plan provenance for ' + w.id);
	}

	const tests = workflows.map(w => ({
		id: w.id, objective: w.title, method: w.steps, expected: w.expected_behavior,
		decisionId: w.researchLink?.decisionId, featureIds: w.feature_ids,
		requirementIds: w.researchLink?.sources?.map(row => row.requirementId) ?? [],
		status: work.invalidProofIds?.includes(w.id) ? 'unverified' : w.status, completedAt: w.completedAt ?? null, limitation: w.reason ?? null,
		observations: (work.invalidProofIds?.includes(w.id) ? [] : w.verification?.receipts ?? []).map(r => ({
			evidenceId: r.id, activityId: r.activityId, tool: r.tool, url: r.result.url, stateKey:r.result.stateKey, at: r.at, assertions: r.result.assertions ?? []
		}))
	}));
	const references = sources.map(({ id, finalUrl, publisher, title, version, authority, publicationDate,
		effectiveDate, contentHash, retrievedAt, superseded, authorityEvidence }) =>
		({ id, finalUrl, publisher, title, version, authority, publicationDate, effectiveDate, contentHash, retrievedAt, superseded, authorityEvidence }));
	return {
		version: 1, runId: session.id, targetUrl: session.targetUrl,
		profile: discovery.features.map(({ id, kind, name, location, evidenceId, testability }) => ({ id, kind, name, location, evidenceId, testability })),
		limitations: discovery.limitations ?? [], references, decisions, tests,
		requirements: requirements.map(({ id, sourceId, controlId, framework, quote }) => ({
			id, sourceId, controlId, framework, quote,
			citationUse: publisherBackgroundSection(usableSources.get(sourceId),controlId) ? 'background' : 'source excerpt',
			requirementResult: decisions.some(d=>d.requirement_ids.includes(id)) &&
				decisions.filter(d=>d.requirement_ids.includes(id)).every(d=>d.classification==='NOT_APPLICABLE') &&
				!blockers.length ? 'NOT_APPLICABLE' : 'NOT_VERIFIABLE',
			testIds: tests.filter(w => w.requirementIds.includes(id)).map(w => w.id)
		})),
		documents: (research.documentReviews ?? []).map(({ id, requirementId, featureId, reviewedAt, documentHash, determination }) =>
			({ id, requirementId, featureId, reviewedAt, documentHash, determination })),
		findings: researchFindings(tests),
		metrics: {
			pagesReviewed: (state.routes ?? []).filter(r => r.reviewed).length,
			frameworks: new Set(requirements.map(r => r.framework)).size, sources: sources.length,
			testsPlanned: tests.length, testsWithEvidence: tests.filter(t => t.observations.length).length,
			testsWithAssertions: tests.filter(t=>t.observations.some(o=>o.assertions.some(a=>['pass','fail'].includes(a.outcome)))).length,
			dispositions: work.counts, elapsedMs: state.telemetry?.elapsedMs ?? null,
			inputTokens: state.telemetry?.reasoner?.inputTokens ?? null, outputTokens: state.telemetry?.reasoner?.outputTokens ?? null,
			recoveries: state.recoveries?.length ?? 0
		},
		blockers
	};
}

export function attachResearchReport(assessment, report) {
	if (report.blockers.length) throw new TypeError('Unresolved research evidence prevents finalization.');
	const unresolved = report.requirements.filter(row => row.requirementResult === 'NOT_VERIFIABLE').length;
	const gates = [...assessment.gates, {
		id: 'researched_requirement_evidence', title: 'Researched requirement evidence',
		status: unresolved ? 'blocked' : 'pass', passed: !unresolved,
		detail: unresolved ? unresolved + ' researched requirement(s) need additional evidence.' : 'All researched requirements have a supported disposition.'
	}];
	const verdict = unresolved && assessment.verdict === 'pass' ? 'blocked' : assessment.verdict;
	const assessmentSha256 = canonicalModeHash([assessment.assessmentSha256, report]);
	return { ...assessment, assessmentSha256, assessmentId: 'sqa-' + assessmentSha256.slice(0, 24),
		verdict, passed: verdict === 'pass', gates, researchReport: structuredClone(report) };
}
