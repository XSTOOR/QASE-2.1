/**
 * Founder Mode project-context detection (Phase 1).
 *
 * Builds the "detected project context" the Founder launcher shows and reuses:
 * the trusted Drytis Studio projectContext (when a QA run created via the
 * signed integration exists), previous QA findings for this owner, and the
 * most recent finalized Founder review for the same owner. Every value is
 * read from server-side trusted sources; nothing here trusts request bodies.
 *
 * Fact taxonomy (the brief requires distinguishing them):
 * - observed:   evidence captured by Qase itself (QA findings, Studio metadata)
 * - user:       context the founder supplied in a prior Founder launch
 * - assumption: never stored here — inferred by the model and labeled in the
 *               report, not by this module.
 */

const MAX_FINDINGS_IN_CONTEXT = 12;
const MAX_FINDING_SUMMARY = 300;

function safeHttpsUrl(value) {
	if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

/** Latest signed Studio review with project metadata for this owner, if any. */
function latestStudioProject(runs) {
	let best;
	for (const session of runs) {
		if (session.mode !== 'qa') continue;
		const integration = session.drytisIntegration;
		const project = integration?.project;
		const context = integration?.projectContext;
		if (!project?.id && !context) continue;
		const weight = (integration?.createdAt ? Date.parse(integration.createdAt) : 0) || session.updatedAt || 0;
		if (!best || weight > best.weight) best = { weight, project, context, session };
	}
	if (!best) return undefined;
	return {
		project: best.project ? { id: best.project.id, name: best.project.name, revision: best.project.revision } : undefined,
		context: best.context,
		sourceRunId: best.session.id,
		sourceRunUrl: best.session.targetUrl ?? best.session.drytisIntegration?.previewUrl
	};
}

/** Most recent finalized Founder review for this owner (saved Founder context). */
function latestFounderRun(runs) {
	const founderRuns = runs.filter(session => session.mode === 'founder');
	let latest;
	for (const session of founderRuns) {
		const founder = session.founder;
		if (!founder) continue;
		const weight = founder.finalizedAt ? Date.parse(founder.finalizedAt) : Date.parse(founder.updatedAt) || session.updatedAt || 0;
		if (!latest || weight > latest.weight) latest = { weight, session };
	}
	return latest?.session;
}

function summarizeFindings(runs) {
	const rows = [];
	for (const session of runs) {
		if (session.mode !== 'qa') continue;
		for (const finding of session.findings ?? []) {
			rows.push({
				runId: session.id,
				title: typeof finding.title === 'string' ? finding.title.slice(0, MAX_FINDING_SUMMARY) : undefined,
				severity: finding.severity,
				category: finding.category,
				url: finding.url,
				status: finding.status,
				ts: finding.ts
			});
		}
	}
	rows.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
	return rows.slice(0, MAX_FINDINGS_IN_CONTEXT);
}

/**
 * Detect the reusable Founder Mode project context from trusted sources.
 *
 * @param {object} options
 * @param {Array<object>} options.runs full session objects for the requesting
 *   owner (all modes) — obtained via the run store, never from request bodies.
 * @returns {object} detected context summary for the launcher + prompt.
 */
export function detectFounderProjectContext({ runs = [] } = {}) {
	const studio = latestStudioProject(runs);
	const founderRun = latestFounderRun(runs);
	const findings = summarizeFindings(runs);

	// Target URL precedence (observed facts only, newest first):
	// 1. The most recent QA run's target (what the founder actually tests).
	// 2. The Studio-integrated review's preview URL.
	// 3. The last Founder review's target URL.
	const qaTargets = runs
		.filter(session => session.mode === 'qa' && session.targetUrl)
		.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	const targetUrl = safeHttpsUrl(qaTargets[0]?.targetUrl)
		?? safeHttpsUrl(studio?.sourceRunUrl)
		?? safeHttpsUrl(founderRun?.founder?.scope?.target?.url);
	const targetName = founderRun?.founder?.scope?.target?.name
		?? studio?.project?.name
		?? (qaTargets[0] ? deriveNameFromUrl(qaTargets[0].targetUrl) : undefined);

	return {
		schemaVersion: 1,
		detectedAt: new Date().toISOString(),
		targetUrl,
		targetName,
		studio: studio ? {
			project: studio.project,
			projectContext: studio.context,
			sourceRunId: studio.sourceRunId
		} : undefined,
		previousFindings: findings.length > 0 ? {
			count: findings.length,
			sample: findings
		} : undefined,
		previousFounder: founderRun ? {
			runId: founderRun.id,
			targetUrl: founderRun.founder?.scope?.target?.url,
			targetName: founderRun.founder?.scope?.target?.name,
			productContext: founderRun.founder?.scope?.productContext,
			finalizedAt: founderRun.founder?.finalizedAt
		} : undefined
	};
}

function deriveNameFromUrl(value) {
	try {
		const url = new URL(value);
		return url.hostname.replace(/^www\./, '');
	} catch {
		return undefined;
	}
}
