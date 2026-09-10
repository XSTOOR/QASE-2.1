import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { AuthError, createLocalAuthService } from './auth.js';
import { DEFAULT_TENANT_CONTEXT } from './tenancy.js';
import { getConfig, saveConfig, withUserConfiguration } from './config.js';
import { createAuthThrottle } from './authThrottle.js';
import { accountSettingsCodec } from './accountSettings.js';

test('settings ciphertext cannot be moved between accounts or saved without a production key', async () => {
	const codec = accountSettingsCodec({ environment: { QASE_SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64url') } });
	const encrypted = await codec.seal('alice', { apiKey: 'private-key' });
	await assert.rejects(codec.open('bob', encrypted));
	assert.deepEqual(await codec.open('alice', encrypted), { apiKey: 'private-key' });
	await assert.rejects(accountSettingsCodec({ environment: { NODE_ENV:'production' } }).seal('alice', {}), /QASE_SECRETS_MASTER_KEY/);
});

test('account settings remain encrypted, isolated and durable; password changes revoke sessions', async () => {
	const { auth, directory } = await service();
	try {
		const alice = await auth.register({ email: 'a@example.com', password: 'old password long enough' });
		const bob = await auth.register({ email: 'b@example.com', password: 'another long password' });
		const id = alice.user.userId;
		await withUserConfiguration(await auth.getSettings(id), settings => auth.saveSettings(id, settings), async () => {
			await saveConfig({ provider: 'custom', baseUrl: 'https://gateway.example.com', apiKey: 'private-alice-key', model: 'alice-model' });
			assert.equal(getConfig().apiKey, 'private-alice-key');
		});
		assert.deepEqual(await auth.getSettings(bob.user.userId), {});
		assert.equal((await auth.getSettings(id)).apiKey, 'private-alice-key');
		assert.doesNotMatch(await fs.readFile(path.join(directory, 'auth.json'), 'utf8'), /private-alice-key/);
		await assert.rejects(auth.changePassword(id, { currentPassword: 'wrong', password: 'new password long enough' }));
		assert.ok(await auth.authenticate(alice.token));
		await auth.changePassword(id, { currentPassword: 'old password long enough', password: 'new password long enough' });
		assert.equal(await auth.authenticate(alice.token), undefined);
		assert.ok(await auth.authenticate(bob.token));
		await assert.rejects(auth.login({ email: 'a@example.com', password: 'old password long enough' }));
		assert.ok((await auth.login({ email: 'a@example.com', password: 'new password long enough' })).token);
		const reopened = createLocalAuthService({ tenantContext: DEFAULT_TENANT_CONTEXT, file: path.join(directory, 'auth.json') });
		assert.equal((await reopened.getSettings(id)).model, 'alice-model');
	} finally { await auth.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('authentication throttle blocks repeated attempts and expires its window', () => {
	let time = 0;
	const consume = createAuthThrottle({ now: () => time });
	assert.equal(consume('a', 2), true);
	assert.equal(consume('a', 2), true);
	assert.equal(consume('a', 2), false);
	assert.equal(consume('b', 2), true);
	time = 900_001;
	assert.equal(consume('a', 2), true);
});

async function service() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qase-auth-'));
	const file = path.join(directory, 'auth.json');
	const auth = createLocalAuthService({ tenantContext: DEFAULT_TENANT_CONTEXT, file });
	await auth.load();
	return { auth, directory };
}

test('local authentication hashes passwords and isolates profiles and memory', async () => {
	const { auth, directory } = await service();
	try {
		const alice = await auth.register({ email: 'Alice@example.com', password: 'correct horse battery staple', displayName: 'Alice' });
		assert.equal(alice.user.email, 'alice@example.com');
		assert.equal((await auth.authenticate(alice.token)).userId, alice.user.userId);
		await auth.putMemory(alice.user.userId, { key: 'timezone', value: 'Asia/Kolkata', kind: 'preference' });
		const bob = await auth.register({ email: 'bob@example.com', password: 'correct horse battery staple', displayName: 'Bob' });
		assert.deepEqual(await auth.listMemory(bob.user.userId), []);
		assert.equal((await auth.profile(alice.user.userId)).profile.timezone, 'UTC');
		await auth.updateProfile(alice.user.userId, { displayName: 'Alice QA', profile: { timezone: 'Asia/Kolkata' } });
		assert.equal((await auth.profile(alice.user.userId)).displayName, 'Alice QA');
		assert.equal((await auth.profile(alice.user.userId)).profile.timezone, 'Asia/Kolkata');
		await assert.rejects(() => auth.login({ email: 'alice@example.com', password: 'wrong password' }), error => error instanceof AuthError && error.status === 401);
	} finally {
		await auth.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('memory rejects credential-shaped content and expires/revokes sessions', async () => {
	const { auth, directory } = await service();
	try {
		const user = await auth.register({ email: `${randomUUID()}@example.com`, password: 'correct horse battery staple', displayName: 'Test' });
		await assert.rejects(() => auth.putMemory(user.user.userId, { key: 'api_key', value: 'never store this' }), error => error.code === 'invalid_memory_key');
		await auth.logout(user.token);
		assert.equal(await auth.authenticate(user.token), undefined);
	} finally {
		await auth.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
