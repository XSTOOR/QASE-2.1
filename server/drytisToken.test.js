import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { createDrytisTokenVerifier, DrytisTokenError } from './drytisToken.js';

const ISSUER = 'https://identity.drytis.example';
const AUDIENCE = 'qase-cell';
const NOW = 1_800_000_000_000;
const ORGANIZATION_ID = '55c15025-8ef4-4ce8-8ad5-4562f33f1852';
const PROJECT_ID = 'f2964599-fb3a-4c4e-acec-ee84d74fab55';
const USER_ID = '9e2fb678-423e-41a0-ae19-e9cae143c606';

function keys(kid) {
	const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
	return {
		privateKey: pair.privateKey,
		jwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }
	};
}

function token(privateKey, kid, patch = {}) {
	const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
	const payload = Buffer.from(JSON.stringify({
		iss: ISSUER,
		aud: AUDIENCE,
		sub: 'drytis-user-42',
		user_id: USER_ID,
		jti: 'one-time-launch-42',
		iat: Math.floor(NOW / 1000) - 5,
		exp: Math.floor(NOW / 1000) + 60,
		email: 'Engineer@Drytis.example',
		name: 'Drytis Engineer',
		role: 'developer',
		organization: { id: ORGANIZATION_ID, slug: 'drytis', name: 'Drytis' },
		project: { id: PROJECT_ID, slug: 'qase', name: 'Qase' },
		...patch
	})).toString('base64url');
	const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
	return `${header}.${payload}.${signature}`;
}

function verifier(jwks, calls) {
	return createDrytisTokenVerifier({
		issuer: ISSUER,
		audience: AUDIENCE,
		jwksUrl: 'https://identity.drytis.example/.well-known/jwks.json',
		now: () => calls.now ?? NOW,
		fetch: async () => {
			calls.count++;
			return { ok: true, headers: new Headers(), text: async () => JSON.stringify({ keys: jwks.current }) };
		}
	});
}

test('verifies a signed, short-lived, audience-bound Drytis launch token', async () => {
	const key = keys('primary');
	const calls = { count: 0 };
	const claims = await verifier({ current: [key.jwk] }, calls).verify(token(key.privateKey, 'primary'));
	assert.deepEqual(claims, {
		subject: 'drytis-user-42', jti: 'one-time-launch-42', actorUserId: USER_ID, email: 'engineer@drytis.example',
		displayName: 'Drytis Engineer', role: 'developer', organizationId: ORGANIZATION_ID,
		organizationSlug: 'drytis', organizationName: 'Drytis', projectId: PROJECT_ID,
		projectSlug: 'qase', projectName: 'Qase', issuer: ISSUER,
		issuedAt: Math.floor(NOW / 1000) - 5, expiresAt: Math.floor(NOW / 1000) + 60
	});
	assert.equal(calls.count, 1);
});

test('refreshes JWKS when Drytis rotates to an unknown signing key', async () => {
	const oldKey = keys('old');
	const nextKey = keys('next');
	const calls = { count: 0 };
	const jwks = { current: [oldKey.jwk] };
	const instance = verifier(jwks, calls);
	await instance.verify(token(oldKey.privateKey, 'old'));
	jwks.current = [nextKey.jwk];
	calls.now = NOW + 10_001;
	await instance.verify(token(nextKey.privateKey, 'next', { jti: 'rotated' }));
	assert.equal(calls.count, 2);
});

test('rejects tampering, wrong audience, long lifetime, and invalid tenant claims', async () => {
	const key = keys('primary');
	const instance = verifier({ current: [key.jwk] }, { count: 0 });
	const valid = token(key.privateKey, 'primary');
	await assert.rejects(() => instance.verify(`${valid.slice(0, -2)}aa`), DrytisTokenError);
	await assert.rejects(() => instance.verify(token(key.privateKey, 'primary', { aud: 'another-service' })), /audience/i);
	await assert.rejects(() => instance.verify(token(key.privateKey, 'primary', {
		iat: Math.floor(NOW / 1000) - 1, exp: Math.floor(NOW / 1000) + 600
	})), /lifetime/i);
	await assert.rejects(() => instance.verify(token(key.privateKey, 'primary', {
		organization: { id: 'not-a-uuid', slug: 'drytis', name: 'Drytis' }
	})), /canonical UUID/i);
});

test('requires HTTPS JWKS outside explicitly controlled tests', () => {
	assert.throws(() => createDrytisTokenVerifier({
		issuer: ISSUER, audience: AUDIENCE, jwksUrl: 'http://identity.example/jwks'
	}), /HTTPS/);
});
