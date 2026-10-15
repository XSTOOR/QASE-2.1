import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectEvidenceBundle } from './evidenceBundle.js';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.65 Safari/537.36';

const SESSION = {
	id: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
	executionLevel: 'SIMULATED',
	executionProviderActual: 'local',
	deviceSessionId: 'RT-42',
	environmentSnapshot: {
		envId: 'ENV-WIN-CHROME-141', device: 'Windows Desktop', os: 'Windows', osVersion: '11',
		browser: 'Chrome', browserCode: 'chrome', browserVersion: '141',
		resolution: '1920x1080', orientation: null
	},
	runtimeFacts: { executionLevel: 'SIMULATED', provider: 'local', userAgent: CHROME_UA, runtimeSessionId: 'RT-42' }
};

const BRIDGE = {
	execution: { executionEngine: 'chromium', provider: 'local' },
	getLastFrame: () => ({ base64: 'ZmFrZQ==', mimeType: 'image/jpeg' }),
	getSecurityBlocks: () => [{ code: 'BROWSER_SERVICE_WORKERS_DISABLED' }]
};

test('R4: bundle carries runtime-observed identity, engine, and session', () => {
	const { bundle } = collectEvidenceBundle({
		session: SESSION, bridge: BRIDGE,
		diagnostics: { console: [{ type: 'log', text: 'hello' }], network: [{ url: 'https://x.test/a.js' }] }
	});
	assert.equal(bundle.type, 'evidence-bundle');
	assert.equal(bundle.identity.browserCode, 'chrome');
	assert.equal(bundle.identity.browserVersionAuthoritative, true);
	assert.equal(bundle.execution.engine, 'chromium');
	assert.equal(bundle.runtimeSessionId, 'RT-42');
	assert.equal(bundle.identityVerified, true);
	assert.deepEqual(bundle.identityMismatches, []);
	assert.equal(bundle.console.entries.length, 1);
	assert.equal(bundle.network.entries.length, 1);
	assert.equal(bundle.screenshot.fileName, 'final-frame-a1b2c3d4.jpg');
	assert.equal(bundle.environment.envId, 'ENV-WIN-CHROME-141');
});

test('R4: identity mismatch is recorded in the bundle, never hidden', () => {
	const mismatched = {
		...SESSION,
		environmentSnapshot: { ...SESSION.environmentSnapshot, browserCode: 'firefox', browser: 'Firefox' }
	};
	const { bundle } = collectEvidenceBundle({ session: mismatched, bridge: BRIDGE, diagnostics: {} });
	assert.equal(bundle.identityVerified, false);
	assert.ok(bundle.identityMismatches.some((m) => /browser mismatch/.test(m)));
});

test('R4: unobservable entries are recorded absent (null), never fabricated', () => {
	const { bundle } = collectEvidenceBundle({ session: { ...SESSION, runtimeFacts: null }, bridge: {}, diagnostics: null });
	assert.equal(bundle.console, null);
	assert.equal(bundle.network, null);
	assert.equal(bundle.screenshot, null);
	// No runtime facts → identity unobservable and honestly marked unverified.
	assert.equal(bundle.identityVerified, false);
	assert.ok(bundle.identityMismatches.some((m) => /not observable/.test(m)));
});

test('R4: oversized console/network lists are truncated with counts', () => {
	const console = Array.from({ length: 900 }, (_, i) => ({ type: 'log', text: `line-${i}` }));
	const network = Array.from({ length: 600 }, (_, i) => ({ url: `https://x.test/${i}` }));
	const { bundle } = collectEvidenceBundle({ session: SESSION, bridge: BRIDGE, diagnostics: { console, network } });
	assert.equal(bundle.console.count, 900);
	assert.equal(bundle.console.entries.length, 500);
	assert.equal(bundle.console.truncated, true);
	assert.equal(bundle.network.count, 600);
	assert.equal(bundle.network.truncated, true);
});

test('R4: long entry text is clipped to the byte bound', () => {
	const { bundle } = collectEvidenceBundle({
		session: SESSION, bridge: BRIDGE,
		diagnostics: { console: [{ type: 'error', text: 'x'.repeat(10_000) }] }
	});
	assert.equal(bundle.console.entries[0].text.length, 2000);
});
