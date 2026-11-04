import { runtimeIntegrity, attestationFor } from './qaTools.js';

/** Narrow correction of the original JEV v1 blanket-coverage blocker.
 * Does not add executed checks, change evidence, or restore a passing verdict.
 */
export function reconcileJevCoverageReport(session) {
	const report = session?.report;
	if (session?.mode !== 'qa' || session.status !== 'done' || report?.verdict !== 'blocked' || session.jev?.version !== 1 || session.jev?.model !== 'jev-1.13' || !session.jev?.decisions?.length) return null;
	const gaps = report.notCovered;
	const blanket = /^(navigation|forms|authentication|search|responsive|broken_links|media): partial or not tested; the JEV controller did not execute the complete required workflow\.$/;
	if (!gaps?.length || !gaps.every(text => blanket.test(text))) return null;
	if (!report.summary?.startsWith('JEV Decisions reviewed ') || !report.covered?.some(text => text.startsWith('Observed '))) return null;
	if (!session.selectedTests?.some(id => ['navigation', 'console_health', 'broken_links'].includes(id))) return null;
	if (!session.todos?.length || session.todos.some(todo => todo.status !== 'completed')) return null;
	const snapshots = session.activities?.filter(activity => activity.toolName === 'browser_snapshot') ?? [];
	const diagnostics = session.activities?.filter(activity => activity.toolName === 'browser_diagnostics') ?? [];
	if (!snapshots.length || snapshots.some(item => item.status !== 'done') || diagnostics.length < snapshots.length || diagnostics.some(item => item.status !== 'done')) return null;
	const finalizer = [...(session.activities ?? [])].reverse().find(item => item.toolName === 'finish_qa_report' && item.status === 'done');
	if (finalizer?.input?.verdict !== 'blocked' || JSON.stringify(finalizer.input.not_covered) !== JSON.stringify(gaps)) return null;
	if (!runtimeIntegrity(session).ok) return null;
	return { ...report,
		verdict: session.findings?.some(item => ['critical', 'high'].includes(item.severity)) ? 'fail' : 'partial',
		summary: `Browser sampling completed with coverage gaps; untested workflows remain unverified. ${report.summary}`,
		recommendations: ['Review the recorded sample and coverage gaps; rerun any additional workflows with explicit inputs.', ...(report.recommendations ?? []).filter(text => session.findings?.length || text !== 'Reproduce recorded findings and resolve them in priority order.')],
		coverageCorrection: { reason: 'JEV v1 incorrectly treated incomplete coverage as a global execution blocker.', correctedAt: new Date().toISOString(), originalReport: structuredClone(report) }
	};
}

/** Narrow repair for the proven, millisecond-scale finalization/capture race. */
export function reconcileLateRuntimeReport(session) {
	const report = session?.report;
	if (session?.mode !== 'qa' || session.status !== 'done' || report?.verdict !== 'blocked') return null;
	if (report.runtimeIdentity?.observedUserAgent) return null;
	const lateBy = Date.parse(session.runtimeFacts?.capturedAt) - Number(report.ts);
	if (!Number.isFinite(lateBy) || lateBy < 0 || lateBy > 5000) return null;
	const synthetic = report.notCovered?.filter(text => String(text).startsWith('Blocked: Runtime identity mismatch with the selected environment: runtime identity not observable (no user agent reported). (failed checks:')) ?? [];
	if (synthetic.length !== 1) return null;
	const finalizer = [...(session.activities || [])].reverse().find(activity => activity.toolName === 'finish_qa_report' && activity.status === 'done');
	const requested = finalizer?.input?.verdict;
	if (!['pass', 'pass_with_issues', 'partial', 'fail'].includes(requested)) return null;
	if (!report.covered?.length || !session.todos?.length || session.todos.some(todo => todo.status !== 'completed')) return null;
	const integrity = runtimeIntegrity(session);
	if (!integrity.ok) return null;
	let verdict = requested;
	if (verdict === 'pass' && session.findings?.length) verdict = 'pass_with_issues';
	if (['pass_with_issues', 'partial'].includes(verdict) && session.findings?.some(finding => ['critical', 'high'].includes(finding.severity))) verdict = 'fail';
	return { ...report, verdict, notCovered: report.notCovered.filter(text => text !== synthetic[0]),
		runtimeIdentity: integrity.identity, attestation: attestationFor(session),
		integrityCorrection: { reason: 'Runtime facts were captured after report finalization.', correctedAt: new Date().toISOString(), originalReport: structuredClone(report), observedCaptureDelayMs: lateBy } };
}
