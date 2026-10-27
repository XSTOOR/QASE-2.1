import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileLateRuntimeReport, reconcileJevCoverageReport } from './runtimeReportReconciliation.js';
const blocker = 'Blocked: Runtime identity mismatch with the selected environment: runtime identity not observable (no user agent reported). (failed checks: runtimeConnected, browserVerified, osVerified, identityMatchesSelection)';
function session() {
	const ts = Date.now();
	return { mode: 'qa', status: 'done', matrixStatus: 'ERROR', findings: [{ severity: 'medium' }, { severity: 'low' }],
		todos: [{ text: 'Test navigation', status: 'completed' }],
		activities: [{ toolName: 'browser_snapshot', status: 'done' }, { toolName: 'finish_qa_report', status: 'done', input: { verdict: 'pass_with_issues' } }],
		environmentSnapshot: { platform: 'macos', browserCode: 'chrome', browserVersion: '151', os: 'macOS' },
		runtimeFacts: { executionLevel: 'SIMULATED', platform: 'Win32', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36', capturedAt: new Date(ts + 36).toISOString() },
		report: { ts, verdict: 'blocked', summary: 'Public pages tested.', covered: ['Navigation'], notCovered: ['Authentication requires credentials.', 'Search is not present.', blocker], runtimeIdentity: { observedUserAgent: null } } };
}
test('proven 36ms race restores the recorded request, preserves skipped checks and audit evidence', () => {
	const original = session(); const corrected = reconcileLateRuntimeReport(original);
	assert.equal(corrected.verdict, 'pass_with_issues'); assert.equal(corrected.integrityCorrection.observedCaptureDelayMs, 36);
	assert.deepEqual(corrected.notCovered, original.report.notCovered.slice(0, 2));
	assert.deepEqual(corrected.integrityCorrection.originalReport, original.report);
	assert.equal(original.report.verdict, 'blocked'); assert.equal(original.matrixStatus, 'ERROR');
	assert.equal(original.findings.length, 2); assert.equal(corrected.runtimeIdentity.browserCode, 'chrome');
});
test('real identity mismatches and explicitly blocked agent reports cannot be repaired', () => {
	const wrong = session(); wrong.environmentSnapshot.browserCode = 'firefox'; assert.equal(reconcileLateRuntimeReport(wrong), null);
	const blocked = session(); blocked.activities[1].input.verdict = 'blocked'; assert.equal(reconcileLateRuntimeReport(blocked), null);
});
test('uncertain or unrelated evidence never upgrades an old report', () => {
	const late = session(); late.runtimeFacts.capturedAt = new Date(late.report.ts + 6000).toISOString(); assert.equal(reconcileLateRuntimeReport(late), null);
	const missing = session(); delete missing.runtimeFacts; assert.equal(reconcileLateRuntimeReport(missing), null);
	const before = session(); before.runtimeFacts.capturedAt = new Date(before.report.ts - 1).toISOString(); assert.equal(reconcileLateRuntimeReport(before), null);
	const unfinished = session(); unfinished.todos[0].status = 'pending'; assert.equal(reconcileLateRuntimeReport(unfinished), null);
});
test('severe findings still force fail during a legitimate reconciliation', () => {
	const severe = session(); severe.findings.push({ severity: 'high' }); assert.equal(reconcileLateRuntimeReport(severe).verdict, 'fail');
});

function oldJevReport() {
	const value = session();
	value.jev = { version: 1, model: 'jev-1.13', decisions: [{ id: 'actual-decision' }] };
	value.selectedTests = ['navigation', 'console_health', 'forms'];
	value.activities.push({ toolName: 'browser_diagnostics', status: 'done' });
	value.report = { verdict: 'blocked', summary: 'JEV Decisions reviewed 1 page observations.', covered: ['Observed https://site.test/ — Test'], notCovered: ['forms: partial or not tested; the JEV controller did not execute the complete required workflow.'] };
	value.activities[1].input = { verdict: 'blocked', not_covered: [...value.report.notCovered] };
	return value;
}
test('known JEV blanket blocker becomes partial with its original report and gaps preserved', () => {
	const original = oldJevReport();
	const corrected = reconcileJevCoverageReport(original);
	assert.equal(corrected.verdict, 'partial');
	assert.deepEqual(corrected.notCovered, original.report.notCovered);
	assert.deepEqual(corrected.coverageCorrection.originalReport, original.report);
	assert.equal(original.report.verdict, 'blocked');
});
test('JEV correction never erases a real blocker, missing evidence or runtime mismatch', () => {
	for (const mutate of [
		s => s.report.notCovered.push('Blocked: Runtime mismatch'),
		s => { s.runtimeFacts = {}; },
		s => { s.environmentSnapshot.browserCode = 'firefox'; },
		s => { s.activities[0].status = 'failed'; },
		s => { s.todos[0].status = 'in_progress'; },
		s => { s.mode = 'sqa'; },
		s => { s.jev.decisions = []; },
		s => { s.report.verdict = 'partial'; }
	]) {
		const value = oldJevReport(); mutate(value);
		assert.equal(reconcileJevCoverageReport(value), null);
	}
	const severe = oldJevReport(); severe.findings.push({ severity: 'high' });
	assert.equal(reconcileJevCoverageReport(severe).verdict, 'fail');
});
