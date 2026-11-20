/**
 * Entry point used by agent.runTurn for Founder sessions. Same live-record
 * contract as the QA and SQA engines: record.running / controller /
 * bridge.getLastFrame() / qaAnswer (sign-in question) / founderReply (the
 * brief question) / dispose().
 */
import { runFounderEngine } from './engine.js';

export { isFounderEngineSession, createFounderRunState, FOUNDER_ENGINE_VERSION } from './engine.js';

export async function runFounderTurn(session, _input, runStore) {
	const record = runStore.liveFor(session.id);
	if (record.running) throw new Error('This session is already running. Stop it first.');
	const controller = new AbortController();
	record.running = true;
	record.controller = controller;
	record.userStopRequested = false;
	record.dispose = () => { record.controller?.abort(); };
	try {
		await runFounderEngine({ session, runStore, record, signal: controller.signal });
	} finally {
		record.running = false;
		record.controller = undefined;
		record.bridge?.stopFrames?.();
	}
}
