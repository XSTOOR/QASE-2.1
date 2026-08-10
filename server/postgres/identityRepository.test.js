import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresIdentityRepository, DrytisTokenReplayError } from './identityRepository.js';

const ORG = '55c15025-8ef4-4ce8-8ad5-4562f33f1852';
const PROJECT = 'f2964599-fb3a-4c4e-acec-ee84d74fab55';
const USER = '9e2fb678-423e-41a0-ae19-e9cae143c606';
const SESSION = '22cdcb33-5038-439a-9d84-5ee2fad35180';
const CLAIMS = {
	issuer: 'https://identity.drytis.example', subject: 'user-42', jti: 'launch-42',
	organizationId: ORG, organizationSlug: 'drytis', organizationName: 'Drytis',
	projectId: PROJECT, projectSlug: 'qase', projectName: 'Qase', actorUserId: USER,
	email: 'engineer@drytis.example', displayName: 'Drytis Engineer', role: 'developer',
	expiresAt: 1_900_000_000
};

function fixture(handler = () => ({ rows: [], rowCount: 1 })) {
	const calls = [];
	const client = {
		async query(text, params = []) { calls.push({ text: text.trim(), params }); return handler(text.trim(), params, calls); },
		release() { calls.push({ text: 'RELEASE', params: [] }); }
	};
	return { calls, repository: createPostgresIdentityRepository({ pool: { connect: async () => client } }) };
}

test('identity exchange provisions only the signed cell and commits replay marker with hashed session material', async () => {
	const target = fixture(text => text.startsWith('INSERT INTO drytis_identities')
		? { rows: [{ user_id: USER }], rowCount: 1 } : { rows: [], rowCount: 1 });
	await target.repository.exchange(CLAIMS, {
		id: SESSION, tokenHash: 'ab'.repeat(32), expiresAt: 1_800_003_600_000
	});
	assert.equal(target.calls[0].text, 'BEGIN');
	assert.match(target.calls[1].text, /set_config\('qase.organization_id'/);
	assert.deepEqual(target.calls[1].params, [ORG, PROJECT]);
	assert.ok(target.calls.some(call => call.text.startsWith('INSERT INTO drytis_token_exchanges')));
	const session = target.calls.find(call => call.text.startsWith('INSERT INTO qase_auth_sessions'));
	assert.equal(session.params[4], 'ab'.repeat(32));
	assert.equal(JSON.stringify(target.calls).includes('signed.jwt.value'), false);
	assert.equal(target.calls.at(-2).text, 'COMMIT');
	assert.equal(target.calls.at(-1).text, 'RELEASE');
});

test('replayed launch JTIs roll back identity and session changes atomically', async () => {
	const target = fixture(text => {
		if (text.startsWith('INSERT INTO drytis_identities')) return { rows: [{ user_id: USER }], rowCount: 1 };
		if (text.startsWith('INSERT INTO drytis_token_exchanges')) throw Object.assign(new Error('duplicate'), { code: '23505' });
		return { rows: [], rowCount: 1 };
	});
	await assert.rejects(() => target.repository.exchange(CLAIMS, {
		id: SESSION, tokenHash: 'ab'.repeat(32), expiresAt: 1_800_003_600_000
	}), DrytisTokenReplayError);
	assert.equal(target.calls.at(-2).text, 'ROLLBACK');
	assert.equal(target.calls.at(-1).text, 'RELEASE');
	assert.equal(target.calls.some(call => call.text.startsWith('INSERT INTO qase_auth_sessions')), false);
});

test('session resolution and revocation are scoped by cookie cell and token hash', async () => {
	const target = fixture(text => {
		if (text.startsWith('SELECT session.id')) return { rows: [{
			id: SESSION, organization_id: ORG, project_id: PROJECT, user_id: USER,
			expires_at: new Date(1_900_000_000_000), email: CLAIMS.email,
			display_name: CLAIMS.displayName, role: CLAIMS.role
		}], rowCount: 1 };
		return { rows: [], rowCount: 1 };
	});
	const reference = { organizationId: ORG, projectId: PROJECT, tokenHash: 'cd'.repeat(32) };
	const session = await target.repository.resolve(reference);
	assert.equal(session.actorUserId, USER);
	assert.equal(session.role, 'developer');
	assert.equal(await target.repository.revoke(reference), true);
	for (const call of target.calls.filter(call => /qase_auth_sessions/.test(call.text))) {
		assert.deepEqual(call.params.slice(0, 3), [ORG, PROJECT, 'cd'.repeat(32)]);
	}
});
