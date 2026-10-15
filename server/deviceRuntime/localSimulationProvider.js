/**
 * Phase 21 · Local Simulation provider.
 *
 * Wraps the existing local Playwright emulation path (browserBridge's
 * ensureContext override). Level is always SIMULATED — the local runtime is a
 * desktop Chromium with device emulation, never a phone, and it says so.
 */

import { EXECUTION_LEVELS as LEVELS } from './provider.js';

export function createLocalSimulationProvider() {
	return {
		id: 'local-simulation',
		capabilities: {
			supportedLevels: [LEVELS.SIMULATED],
			canRotate: true,           // Playwright can set a new viewport size
			permissionsSupported: ['camera', 'microphone', 'geolocation', 'notifications'],
			physicalDevices: false,
			// The emulated slot is exclusive while a run drives the shared local
			// Chromium context, but waits never starve: requests that arrive
			// while the slot is busy queue and auto-start on release.
			queueable: true
		},

		/** The emulated context is created by browserBridge; the provider records the session shell. */
		async create_session({ environment, linkedRunId, linkedTestCaseId } = {}) {
			return {
				sessionId: null, // assigned by the manager
				environment: environment ?? null,
				level: LEVELS.SIMULATED,
				status: 'created',
				linkedRunId: linkedRunId ?? null,
				linkedTestCaseId: linkedTestCaseId ?? null
			};
		},

		async get_device(session) {
			return {
				id: session?.environment?.device ?? 'local-desktop',
				name: session?.environment?.device ?? 'Local desktop Chromium',
				type: session?.environment?.deviceType ?? 'desktop',
				level: LEVELS.SIMULATED,
				honest: 'Emulated device on local desktop Chromium — not physical hardware.'
			};
		},

		async start_session(session) {
			// Actual browser work happens in browserBridge when the run starts.
			return { ...session, status: 'running', startedAt: new Date().toISOString() };
		},

		async execute_test(session, { run }) {
			// Execution is driven by agent.js runTurn; the provider only labels.
			return { sessionId: session.sessionId, level: LEVELS.SIMULATED, delegated: true, runId: run?.id ?? null };
		},

		async capture_screenshot() {
			// Screenshots flow through the existing frame capture pipeline.
			return { supported: true, via: 'browserBridge frames' };
		},

		async capture_video() {
			// No video recording in the local pipeline today — honest answer.
			return { supported: false, reason: 'Local pipeline records frames, not video.' };
		},

		async capture_logs(session) {
			return { supported: true, via: 'run events', sessionId: session?.sessionId ?? null };
		},

		async collect_device_information(session) {
			// Runtime facts are read live by browserBridge (UA/viewport/DPR).
			return { supported: true, via: 'browserBridge.readRuntimeFacts', sessionId: session?.sessionId ?? null };
		},

		async stop_session(session) {
			return { ...session, status: 'done', endedAt: new Date().toISOString() };
		}
	};
}
