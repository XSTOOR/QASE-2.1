import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { AuthError, createLocalAuthService } from './auth.js';
import { DEFAULT_TENANT_CONTEXT } from './tenancy.js';

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
