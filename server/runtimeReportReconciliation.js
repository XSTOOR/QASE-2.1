import { runtimeIntegrity, attestationFor } from './qaTools.js';

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
	if (!['pass', 'pass_with_issues', 'fail'].includes(requested)) return null;
	if (!report.covered?.length || !session.todos?.length || session.todos.some(todo => todo.status !== 'completed')) return null;
	const integrity = runtimeIntegrity(session);
	if (!integrity.ok) return null;
	let verdict = requested;
	if (verdict === 'pass' && session.findings?.length) verdict = 'pass_with_issues';
	if (verdict === 'pass_with_issues' && session.findings?.some(finding => ['critical', 'high'].includes(finding.severity))) verdict = 'fail';
	return { ...report, verdict, notCovered: report.notCovered.filter(text => text !== synthetic[0]),
		runtimeIdentity: integrity.identity, attestation: attestationFor(session),
		integrityCorrection: { reason: 'Runtime facts were captured after report finalization.', correctedAt: new Date().toISOString(), originalReport: structuredClone(report), observedCaptureDelayMs: lateBy } };
}
