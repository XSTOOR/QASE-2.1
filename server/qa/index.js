/**
 * Entry point used by agent.runTurn for QA-mode sessions.
 *
 * Owns the live-record contract the rest of the server relies on:
 *   record.running / record.controller / record.userStopRequested
 *   record.bridge.getLastFrame() for the live view
 *   record.dispose() for cleanup
 */
import { runQaEngine } from './engine.js';

export { publicQaState, ENGINE_VERSION, isQaEngineSession } from './engine.js';

export async function runQaTurn(session, input, runStore) {
	const record = runStore.liveFor(session.id);
	if (record.running) throw new Error('This session is already running. Stop it first.');
	const controller = new AbortController();
	record.running = true;
	record.controller = controller;
	record.userStopRequested = false;
	record.dispose = () => { record.controller?.abort(); };
	try {
		await runQaEngine({ session, runStore, record, signal: controller.signal });
	} finally {
		record.running = false;
		record.controller = undefined;
		record.bridge?.stopFrames?.();
	}
}
