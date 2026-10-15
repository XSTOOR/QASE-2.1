import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidProvider, EXECUTION_LEVELS as LEVELS } from './provider.js';
import { createLocalSimulationProvider } from './localSimulationProvider.js';
import { createBrowserstackRuntimeProvider } from './browserstackRuntimeProvider.js';
import { createNullRealDeviceProvider, NOT_AVAILABLE_FOR_REAL_EXECUTION } from './nullRealDeviceProvider.js';
import { createDeviceRuntimeManager } from './manager.js';

const IPHONE_ENV = {
	envId: 'ENV-IOS-IP16PRO-18.3-SAF-18.3',
	platform: 'ios',
	device: 'iPhone 16 Pro',
	osVersion: '18.3',
	browser: 'Safari',
	deviceType: 'mobile',
	runtimeCapabilities: { browserName: 'safari', os: 'ios', osVersion: '18.3', deviceName: 'iPhone 16 Pro', realMobile: true }
};

test('all three concrete providers satisfy the interface contract', () => {
	assert.equal(isValidProvider(createLocalSimulationProvider()), true);
	assert.equal(isValidProvider(createBrowserstackRuntimeProvider({ credentials: { username: 'u', accessKey: 'k' } })), true);
	assert.equal(isValidProvider(createNullRealDeviceProvider()), true);
	assert.equal(isValidProvider({ id: 'broken' }), false);
	assert.equal(isValidProvider(null), false);
});

test('local simulation provider always reports SIMULATED, never physical', () => {
	const provider = createLocalSimulationProvider();
	assert.deepEqual(provider.capabilities.supportedLevels, [LEVELS.SIMULATED]);
	assert.equal(provider.capabilities.physicalDevices, false);
});

test('browserstack provider without credentials reports unavailable with zero levels', () => {
	const provider = createBrowserstackRuntimeProvider({ credentials: null });
	assert.equal(provider.isAvailable(), false);
	assert.deepEqual(provider.capabilities.supportedLevels, []);
	assert.match(provider.capabilities.unavailableReason, /credentials not configured/);
});

test('browserstack attestation: REAL_DEVICE only with realMobile + deviceName, never by name', () => {
	const provider = createBrowserstackRuntimeProvider({ credentials: { username: 'u', accessKey: 'k' } });
	// An env with realMobile attestation → physical.
	assert.equal(provider.attestPhysicalDevice(IPHONE_ENV).physical, true);
	// Same device name, no attestation → NOT physical.
	const unattested = { ...IPHONE_ENV, runtimeCapabilities: { browserName: 'safari', deviceName: 'iPhone 16 Pro' } };
	assert.equal(provider.attestPhysicalDevice(unattested).physical, false);
	// macOS remote is a VM, not physical.
	assert.equal(provider.attestPhysicalDevice({ runtimeCapabilities: { os: 'OS X', osVersion: 'Sonoma' } }).physical, false);
});

test('null provider answers NOT AVAILABLE FOR REAL EXECUTION, never fabricates', async () => {
	const provider = createNullRealDeviceProvider();
	const created = await provider.create_session({ environment: IPHONE_ENV });
	assert.equal(created.notAvailable, NOT_AVAILABLE_FOR_REAL_EXECUTION);
	assert.equal(created.unavailable, true);
	const exec = await provider.execute_test();
	assert.equal(exec.notAvailable, NOT_AVAILABLE_FOR_REAL_EXECUTION);
});

test('manager: REAL DEVICE request with no lab returns not_available + the three fallback choices', async () => {
	const manager = createDeviceRuntimeManager({
		providers: [createLocalSimulationProvider(), createBrowserstackRuntimeProvider({ credentials: null }), createNullRealDeviceProvider()]
	});
	const result = await manager.requestSession({ environment: IPHONE_ENV, requestedLevel: LEVELS.REAL_DEVICE });
	assert.equal(result.status, 'not_available');
	assert.equal(result.notAvailable, NOT_AVAILABLE_FOR_REAL_EXECUTION);
	assert.deepEqual(result.choices.map((choice) => choice.action), ['run_simulated']);
	assert.equal(result.maximumLevel, LEVELS.SIMULATED, 'with no BrowserStack creds the honest max is SIMULATED');
});

test('manager: with browserstack creds the max level for a realMobile env is REAL_DEVICE', async () => {
	const manager = createDeviceRuntimeManager({
		providers: [createLocalSimulationProvider(), createBrowserstackRuntimeProvider({ credentials: { username: 'u', accessKey: 'k' } })]
	});
	assert.equal(manager.maximumLevelFor(IPHONE_ENV), LEVELS.REAL_DEVICE);
	// A macOS env (no realMobile) caps at VIRTUAL_DEVICE — the VM is not a phone.
	const macEnv = { envId: 'ENV-MAC-SONOMA-SAF-17.0', platform: 'macos', runtimeCapabilities: { os: 'OS X' } };
	assert.equal(manager.maximumLevelFor(macEnv), LEVELS.VIRTUAL_DEVICE);
});

test('manager: simulated session starts immediately and is labeled SIMULATED end-to-end', async () => {
	const manager = createDeviceRuntimeManager({ providers: [createLocalSimulationProvider()] });
	const result = await manager.requestSession({ environment: IPHONE_ENV, requestedLevel: LEVELS.SIMULATED });
	assert.equal(result.status, 'started');
	assert.match(result.session.sessionId, /^QASE-DR-\d{4}$/);
	assert.equal(result.session.level, LEVELS.SIMULATED);
	assert.equal(result.session.status, 'running');
});

test('manager: second request for a busy queueable device queues with position; release auto-starts it', async () => {
	// Only browserstack is queueable; give it creds so sessions exist.
	const manager = createDeviceRuntimeManager({
		providers: [createBrowserstackRuntimeProvider({ credentials: { username: 'u', accessKey: 'k' } })]
	});
	const first = await manager.requestSession({ environment: IPHONE_ENV, requestedLevel: LEVELS.VIRTUAL_DEVICE });
	assert.equal(first.status, 'started');
	const second = await manager.requestSession({ environment: IPHONE_ENV, requestedLevel: LEVELS.VIRTUAL_DEVICE });
	assert.equal(second.status, 'queued');
	assert.equal(second.queuePosition.position, 1);
	assert.equal(second.session.status, 'queued');

	// Board shows BUSY with a queue length.
	const board = manager.deviceBoard();
	assert.equal(board[0].status, 'BUSY');
	assert.equal(board[0].queueLength, 1);

	// Releasing the first auto-starts the second.
	const release = await manager.completeSession(first.session.sessionId, { result: 'passed' });
	assert.equal(release.released, true);
	assert.equal(release.startedNext, second.session.sessionId);
	const promoted = manager.getSession(second.session.sessionId);
	assert.equal(promoted.status, 'running');
	// Device goes BUSY again for the promoted session.
	assert.equal(manager.deviceBoard()[0].currentSessionId, second.session.sessionId);
});

test('manager: cancel while queued removes cleanly; while running releases the device', async () => {
	const manager = createDeviceRuntimeManager({
		providers: [createBrowserstackRuntimeProvider({ credentials: { username: 'u', accessKey: 'k' } })]
	});
	const first = await manager.requestSession({ environment: IPHONE_ENV, requestedLevel: LEVELS.VIRTUAL_DEVICE });
	const second = await manager.requestSession({ environment: IPHONE_ENV, requestedLevel: LEVELS.VIRTUAL_DEVICE });

	// Cancel the QUEUED one.
	const cancelQueued = await manager.cancelSession(second.session.sessionId);
	assert.equal(cancelQueued.cancelled, true);
	assert.equal(cancelQueued.wasQueued, true);
	assert.equal(manager.getSession(second.session.sessionId).status, 'cancelled');

	// Cancel the RUNNING one → device released.
	const cancelRunning = await manager.cancelSession(first.session.sessionId);
	assert.equal(cancelRunning.cancelled, true);
	assert.equal(cancelRunning.wasRunning, true);
	assert.equal(manager.deviceBoard()[0].status, 'AVAILABLE');
});

test('manager: provider crash mid-session marks failed and the queue advances (no stuck BUSY)', async () => {
	const crashing = {
		...createBrowserstackRuntimeProvider({ credentials: { username: 'u', accessKey: 'k' } }),
		id: 'crashing-browserstack',
		async start_session(session) {
			throw new Error('simulated provider crash');
		}
	};
	const manager = createDeviceRuntimeManager({ providers: [crashing] });
	const result = await manager.requestSession({ environment: IPHONE_ENV, requestedLevel: LEVELS.VIRTUAL_DEVICE });
	assert.equal(result.status, 'failed');
	assert.match(result.session.reason, /simulated provider crash/);
	// The device must NOT stay BUSY after the crash.
	assert.equal(manager.deviceBoard()[0].status, 'AVAILABLE');
	assert.equal(manager.getSession(result.session.sessionId).status, 'failed');
});

test('manager: sessions list is queryable and links run + test case', async () => {
	const manager = createDeviceRuntimeManager({ providers: [createLocalSimulationProvider()] });
	await manager.requestSession({
		environment: IPHONE_ENV, requestedLevel: LEVELS.SIMULATED,
		linkedRunId: 'run-123', linkedTestCaseId: 'case-9'
	});
	const list = manager.listSessions();
	assert.equal(list.length, 1);
	assert.equal(list[0].linkedRunId, 'run-123');
	assert.equal(list[0].linkedTestCaseId, 'case-9');
	assert.equal(list[0].level, LEVELS.SIMULATED);
});

test('selectForRun: agent bridge returns honest SIMULATED with a local provider and links the run', async () => {
	const manager = createDeviceRuntimeManager({ providers: [createLocalSimulationProvider()] });
	// R3 #14492: a REAL_DEVICE request with only a SIMULATED provider is
	// BLOCKED (not_available) — never silently downgraded.
	const requested = await manager.selectForRun({
		session: { id: 'run-777', environment: IPHONE_ENV, executionLevelRequested: LEVELS.REAL_DEVICE }
	});
	assert.equal(requested.status, 'not_available');
	assert.notEqual(requested.executionLevel, LEVELS.REAL_DEVICE);
	assert.ok(Array.isArray(requested.choices) && requested.choices.length > 0);
	// An explicit SIMULATED request starts and links the run.
	const selected = await manager.selectForRun({
		session: { id: 'run-777b', environment: IPHONE_ENV, executionLevelRequested: LEVELS.SIMULATED }
	});
	assert.equal(selected.executionLevel, LEVELS.SIMULATED);
	assert.equal(selected.provider, 'local-simulation');
	assert.equal(selected.deviceSession.linkedRunId, 'run-777b');
});

test('selectForRun: returns null when the record has no environment', async () => {
	const manager = createDeviceRuntimeManager({ providers: [createLocalSimulationProvider()] });
	assert.equal(await manager.selectForRun({ session: { id: 'x' } }), null);
});

test('selectForRun: SIMULATED request starts a session linked to the run', async () => {
	const manager = createDeviceRuntimeManager({ providers: [createLocalSimulationProvider()] });
	const selected = await manager.selectForRun({
		session: { id: 'run-888', environment: IPHONE_ENV, executionLevelRequested: LEVELS.SIMULATED }
	});
	assert.equal(selected.status, 'started');
	assert.equal(selected.executionLevel, LEVELS.SIMULATED);
	assert.equal(selected.deviceSession.linkedRunId, 'run-888');
	assert.equal(selected.provider, 'local-simulation');
});

// ---------------------------------------------------------------------------
// R1 #14490 · Honest availability baseline
// ---------------------------------------------------------------------------

test('R1/RT2: seedBoard marks local-simulated environments by real browser support', async () => {
	const manager = createDeviceRuntimeManager({ providers: [createLocalSimulationProvider()] });
	const seeded = manager.seedBoard(
		[IPHONE_ENV],
		// RT2: the real resolver decides executable vs not — chrome is
		// executable locally, so the honest status is AVAILABLE (labeled
		// SIMULATED execution — a real local browser binary, never a device farm).
		{ resolveBrowserSupport: async () => ({ status: 'supported', reason: 'local binary' }) }
	);
	assert.equal(seeded, 1);
	await new Promise((resolve) => setTimeout(resolve, 10));
	const board = manager.deviceBoard();
	assert.equal(board[0].status, 'AVAILABLE');
	assert.equal(board[0].unavailableReason, null);
	assert.equal(board[0].maximumLevel, LEVELS.SIMULATED);
});

test('RT2: seedBoard marks NOT_SUPPORTED browsers UNAVAILABLE with the exact reason', async () => {
	const manager = createDeviceRuntimeManager({ providers: [createLocalSimulationProvider()] });
	manager.seedBoard(
		[{ ...IPHONE_ENV, browserCode: 'duckduckgo', browser: 'DuckDuckGo' }],
		{ resolveBrowserSupport: async () => ({ status: 'not_supported', reason: 'DuckDuckGo is a mobile-only browser with no Linux desktop build and no automation channel.' }) }
	);
	await new Promise((resolve) => setTimeout(resolve, 10));
	const board = manager.deviceBoard();
	assert.equal(board[0].status, 'UNAVAILABLE');
	assert.match(board[0].unavailableReason, /mobile-only browser/);
});

test('R1: seedBoard keeps AVAILABLE when a real runtime provider is connected', () => {
	const manager = createDeviceRuntimeManager({
		providers: [createBrowserstackRuntimeProvider({ credentials: { username: 'u', accessKey: 'k' } })]
	});
	manager.seedBoard([IPHONE_ENV]);
	const board = manager.deviceBoard();
	assert.equal(board[0].status, 'AVAILABLE');
	assert.equal(board[0].unavailableReason, null);
	assert.equal(board[0].maximumLevel, LEVELS.REAL_DEVICE);
});

test('R1: seedBoard is additive — an existing BUSY device is never forced OFFLINE', async () => {
	const manager = createDeviceRuntimeManager({
		providers: [createBrowserstackRuntimeProvider({ credentials: { username: 'u', accessKey: 'k' } })]
	});
	await manager.requestSession({ environment: IPHONE_ENV, requestedLevel: LEVELS.VIRTUAL_DEVICE });
	assert.equal(manager.deviceBoard()[0].status, 'BUSY');
	manager.seedBoard([IPHONE_ENV]);
	assert.equal(manager.deviceBoard()[0].status, 'BUSY');
});

test('R1: a provider configured WITHOUT credentials leaves the board OFFLINE', () => {
	const manager = createDeviceRuntimeManager({ providers: [createBrowserstackRuntimeProvider()] });
	// No resolveBrowserSupport injected → the pre-attestation baseline holds
	// (OFFLINE names the missing real-device runtime). The RT2 local-support
	// pass only runs when the resolver is provided.
	manager.seedBoard([IPHONE_ENV]);
	const board = manager.deviceBoard();
	assert.equal(board[0].status, 'OFFLINE');
});

// ---------------------------------------------------------------------------
// R3 #14492 · No-silent-fallback in the agent bridge
// ---------------------------------------------------------------------------

test('R3: selectForRun blocks a REAL_DEVICE request when the board is SIMULATED-only', async () => {
	const manager = createDeviceRuntimeManager({ providers: [createLocalSimulationProvider()] });
	const selected = await manager.selectForRun({
		session: { id: 'run-901', environment: IPHONE_ENV, executionLevelRequested: 'REAL_DEVICE' }
	});
	assert.equal(selected.status, 'not_available');
	assert.match(selected.reason, /No connected runtime supports REAL_DEVICE/);
	assert.ok(Array.isArray(selected.choices));
	// The only honest choice left is an explicit Simulated run.
	assert.ok(selected.choices.every((c) => c.action === 'run_simulated'));
});

test('R3: selectForRun still starts SIMULATED requests with the local provider', async () => {
	const manager = createDeviceRuntimeManager({ providers: [createLocalSimulationProvider()] });
	const selected = await manager.selectForRun({
		session: { id: 'run-902', environment: IPHONE_ENV, executionLevelRequested: 'SIMULATED' }
	});
	assert.equal(selected.status, 'started');
	assert.equal(selected.executionLevel, 'SIMULATED');
});
