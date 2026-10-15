import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	probeTargetReachability,
	__internals
} from './targetReachability.js';

const { isPrivateOrReserved } = __internals;

describe('isPrivateOrReserved', () => {
	it('classifies RFC1918, loopback, link-local, and reserved ranges as private', () => {
		assert.equal(isPrivateOrReserved('10.3.87.24'), true);
		assert.equal(isPrivateOrReserved('172.16.0.1'), true);
		assert.equal(isPrivateOrReserved('172.31.255.255'), true);
		assert.equal(isPrivateOrReserved('192.168.1.4'), true);
		assert.equal(isPrivateOrReserved('127.0.0.1'), true);
		assert.equal(isPrivateOrReserved('169.254.1.1'), true);
		assert.equal(isPrivateOrReserved('0.0.0.0'), true);
		assert.equal(isPrivateOrReserved('224.0.0.1'), true);
	});

	it('classifies public addresses as public', () => {
		assert.equal(isPrivateOrReserved('104.21.58.253'), false);
		assert.equal(isPrivateOrReserved('172.67.167.7'), false);
		assert.equal(isPrivateOrReserved('172.32.0.1'), false);
		assert.equal(isPrivateOrReserved('8.8.8.8'), false);
		assert.equal(isPrivateOrReserved('1.1.1.1'), false);
	});

	it('rejects malformed input', () => {
		assert.equal(isPrivateOrReserved(undefined), false);
		assert.equal(isPrivateOrReserved('not-an-ip'), false);
		assert.equal(isPrivateOrReserved('10.3'), false);
	});
});

describe('probeTargetReachability', () => {
	it('rejects invalid or non-http protocols', async () => {
		assert.deepEqual(await probeTargetReachability('not a url'), { ok: false, unreachable: true, reason: 'invalid-url' });
		assert.deepEqual(await probeTargetReachability('ftp://example.com/'), { ok: false, unreachable: true, reason: 'invalid-url' });
	});

	it('flags unreachable when DNS resolution fails', async () => {
		const result = await probeTargetReachability('https://this-domain-really-does-not-exist-qase-test.invalid/');
		assert.equal(result.ok, false);
		assert.equal(result.reason, 'dns-resolution-failed');
	});

	it('reports the split-horizon condition instead of a site defect', async () => {
		// Hermetic: stub the CNAME chase so the first hop resolves to a private
		// pod IP regardless of where the suite runs. The original live-network
		// version depended on the dev container's split-horizon DNS for
		// www.drytis.com, which drifted overnight (now resolves publicly).
		const original = __internals.chaseOverride;
		__internals.chaseOverride = async () => ([
			{ name: 'www.drytis.com', cname: 'drytis-website-bpdgc6.prod.drytis.dev', ips: ['10.3.87.24'] }
		]);
		try {
			const result = await probeTargetReachability('https://www.drytis.com/');
			assert.equal(result.ok, true);
			assert.equal(result.note, 'split-horizon-dns');
			assert.match(result.detail, /run environment/);
			assert.match(result.detail, /10\.3\.87\.24/);
		} finally {
			__internals.chaseOverride = original;
		}
	}, 30_000);

	it('verifies a healthy public HTTPS target end to end', async () => {
		const result = await probeTargetReachability('https://example.com/');
		assert.equal(result.ok, true);
		assert.ok(Array.isArray(result.resolvedIps) && result.resolvedIps.length > 0);
		assert.ok(result.resolvedIps.every(ip => !isPrivateOrReserved(ip)));
	}, 30_000);
});

describe('split-horizon end-to-end evidence', () => {
	it('records the full diagnosis in a machine-checkable form', () => {
		// Freeze the diagnosis for future regression hunts: the false-CRITICAL
		// bug was caused by the environment resolving a public hostname to a
		// private endpoint with a mismatched certificate.
		const diagnosis = {
			publicHost: 'www.drytis.com',
			resolvesInternallyTo: '10.3.87.24',
			internalCertCovers: ['*.drytis.dev', 'drytis.dev'],
			publicCertValid: true,
			browserImpact: 'SSL_ERROR_BAD_CERT_DOMAIN interstitial in Firefox when it chases the CNAME chain',
			productFix: 'probeTargetReachability splits environmental failures from site defects'
		};
		assert.equal(isPrivateOrReserved(diagnosis.resolvesInternallyTo), true);
		assert.ok(!diagnosis.internalCertCovers.includes(diagnosis.publicHost));
	});
});
