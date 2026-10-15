import { parseArgs } from 'node:util';
import { loadSessions, getSession, allSessions, emit, addMessage, flushSessions } from '../server/store.js';
import { reconcileLateRuntimeReport } from '../server/runtimeReportReconciliation.js';

const { values } = parseArgs({ options: { 'run-id': { type: 'string' }, apply: { type: 'boolean', default: false } } });
if (!/^[a-f0-9-]{36}$/i.test(values['run-id'] || '')) throw Error('Specify the exact --run-id.');
if (values.apply) {
	let online = false;
	try { online = (await fetch(`http://127.0.0.1:${process.env.PORT || 5173}/healthz`, { signal: AbortSignal.timeout(1500) })).ok; } catch {}
	if (online) throw Error('Stop the local Qase server before applying a persisted repair.');
}
loadSessions();
if (allSessions().some(session => ['running', 'awaiting_input'].includes(session.status))) throw Error('Active or waiting executions exist; do not repair while work is in progress.');
const session = getSession(values['run-id']);
const corrected = reconcileLateRuntimeReport(session);
if (!corrected) throw Error('This run does not meet the strict late-capture repair criteria. No report changed.');
console.log(JSON.stringify({ runId: session.id, before: session.report.verdict, after: corrected.verdict, captureDelayMs: corrected.integrityCorrection.observedCaptureDelayMs, findings: session.findings.length, applied: values.apply }));
if (values.apply) {
	session.report = corrected;
	emit(session, 'report', { report: corrected });
	addMessage(session, { role: 'agent', text: `Report integrity correction: browser identity was recorded ${corrected.integrityCorrection.observedCaptureDelayMs}ms after finalization. The captured evidence now passes verification. Restored the originally requested verdict (${corrected.verdict}); findings and untested areas are unchanged. Any parent matrix timeout remains unchanged.` });
	flushSessions();
}
