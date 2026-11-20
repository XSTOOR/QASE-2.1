/**
 * Entry point used by agent.runTurn for SQA (compliance) sessions. Same
 * live-record contract as the QA engine: record.running / controller /
 * bridge.getLastFrame() / qaAnswer (sign-in question) / dispose().
 */
import { runSqaEngine } from './engine.js';

export { isSqaEngineSession, createSqaRunState, SQA_ENGINE_VERSION } from './engine.js';

export async function runSqaTurn(session, _input, runStore) {
	const record = runStore.liveFor(session.id);
	if (record.running) throw new Error('This session is already running. Stop it first.');
	const controller = new AbortController();
	record.running = true;
	record.controller = controller;
	record.userStopRequested = false;
	record.dispose = () => { record.controller?.abort(); };
	try {
		await runSqaEngine({ session, runStore, record, signal: controller.signal });
	} finally {
		record.running = false;
		record.controller = undefined;
		record.bridge?.stopFrames?.();
	}
}
