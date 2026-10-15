import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUserAgent, verifyRuntimeIdentity } from './runtimeIdentity.js';

test('R2: parseUserAgent detects each browser brand and version', () => {
	assert.equal(parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.65 Safari/537.36').browserCode, 'chrome');
	assert.equal(parseUserAgent('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0').browserCode, 'edge');
	assert.equal(parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:141.0) Gecko/20100101 Firefox/141.0').browserCode, 'firefox');
	assert.equal(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15').browserCode, 'safari');
	const safari = parseUserAgent('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15');
	assert.equal(safari.browserVersion, '18.0', 'safari version from Version/ token, not WebKit build');
	assert.equal(parseUserAgent('Mozilla/5.0 (X11; Linux) Opera/9.80').browserCode, 'opera');
});

test('R2: iOS wrapper apps report the WebKit engine, not Blink/Gecko', () => {
	const crios = parseUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1');
	assert.equal(crios.browserCode, 'chrome');
	assert.equal(crios.engine, 'WebKit');
	assert.equal(crios.platformHint, 'ios');
	const fxios = parseUserAgent('Mozilla/5.0 (iPad; CPU OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/141.0 Mobile/15E148 Safari/605.1');
	assert.equal(fxios.browserCode, 'firefox');
	assert.equal(fxios.engine, 'WebKit');
});

test('R2: desktop Firefox reports the Gecko engine; desktop Chrome Blink', () => {
	assert.equal(parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:141.0) Gecko/20100101 Firefox/141.0').engine, 'Gecko');
	assert.equal(parseUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/141.0.0.0 Safari/537.36').engine, 'Blink');
});

test('R2: matching selection verifies cleanly', () => {
	const result = verifyRuntimeIdentity({
		runtimeFacts: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.65 Safari/537.36' },
		environment: { platform: 'windows', browserCode: 'chrome', browserVersion: '141' }
	});
	assert.equal(result.ok, true, result.mismatches.join('; '));
	assert.equal(result.identity.browserCode, 'chrome');
	assert.equal(result.identity.browserVersionAuthoritative, true);
});

test('R2: Chrome running when Firefox selected is a BLOCK', () => {
	const result = verifyRuntimeIdentity({
		runtimeFacts: { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/141.0.0.0 Safari/537.36' },
		environment: { platform: 'windows', browserCode: 'firefox', browserVersion: '141' }
	});
	assert.equal(result.ok, false);
	assert.ok(result.mismatches.some((m) => /browser mismatch/.test(m)));
});

test('R2: major-version drift is a BLOCK; full-version runtime report is not', () => {
	const base = { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.7390.65 Safari/537.36' };
	const wrong = verifyRuntimeIdentity({ runtimeFacts: base, environment: { platform: 'windows', browserCode: 'chrome', browserVersion: '141' } });
	assert.equal(wrong.ok, false);
	assert.ok(wrong.mismatches.some((m) => /version mismatch/.test(m)));
	const right = verifyRuntimeIdentity({ runtimeFacts: base, environment: { platform: 'windows', browserCode: 'chrome', browserVersion: '140' } });
	assert.equal(right.ok, true);
});

test('R2: platform mismatch is a BLOCK (Android UA vs iOS selection)', () => {
	const result = verifyRuntimeIdentity({
		runtimeFacts: { userAgent: 'Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36' },
		environment: { platform: 'ios', browserCode: 'chrome', browserVersion: '140' }
	});
	assert.equal(result.ok, false);
	assert.ok(result.mismatches.some((m) => /platform mismatch/.test(m)));
});

test('R2: non-WebKit engine on iOS wrapper browser is a BLOCK', () => {
	// A UA claiming Chrome-on-iPhone WITHOUT any WebKit/Safari token parses
	// as Blink — the engine honesty gate must block it.
	const result = verifyRuntimeIdentity({
		runtimeFacts: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) Chrome/140.0.0.0 Mobile' },
		environment: { platform: 'ios', browserCode: 'chrome', browserVersion: '140' }
	});
	assert.equal(result.ok, false);
	assert.ok(result.mismatches.some((m) => /engine mismatch/.test(m)));
});

test('R2: Safari on iPadOS with WebKit engine verifies (native browser)', () => {
	const result = verifyRuntimeIdentity({
		runtimeFacts: { userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1' },
		environment: { platform: 'ipados', browserCode: 'safari', browserVersion: '18.3' }
	});
	assert.equal(result.ok, true, result.mismatches.join('; '));
});

test('R2: missing runtime facts BLOCK (unverifiable runtime)', () => {
	const result = verifyRuntimeIdentity({ runtimeFacts: null, environment: { platform: 'windows', browserCode: 'chrome', browserVersion: '141' } });
	assert.equal(result.ok, false);
	assert.ok(result.mismatches[0].includes('not observable'));
});
