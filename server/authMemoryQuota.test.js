import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPostgresAuthService } from './auth.js';
import { DEFAULT_TENANT_CONTEXT } from './tenancy.js';

function fixture({ accountExists = true } = {}) {
	const entries = new Map(Array.from({ length: 99 }, (_, index) => [`item${index}`, { id: `id${index}` }]));
	let tail = Promise.resolve();
	let released = 0;
	const pool = { async connect() {
		let unlock;
		return {
			async query(sql, values = []) {
				if (sql === 'BEGIN' || sql.includes('set_config')) return { rows: [] };
				if (sql === 'COMMIT' || sql === 'ROLLBACK') { unlock?.(); unlock = undefined; return { rows: [] }; }
				if (sql.includes('FOR UPDATE')) {
					assert.match(sql, /FROM qase_user_profiles/);
					assert.match(sql, /organization_id = \$2 AND project_id = \$3/);
					assert.deepEqual(values, ['account', DEFAULT_TENANT_CONTEXT.organizationId, DEFAULT_TENANT_CONTEXT.projectId]);
					const previous = tail;
					tail = new Promise(resolve => { unlock = resolve; });
					await previous;
					return { rows: accountExists ? [{ user_id: 'account' }] : [] };
				}
				if (sql.startsWith('SELECT id FROM qase_memory_entries')) return { rows: entries.has(values[2]) ? [entries.get(values[2])] : [] };
				if (sql.startsWith('SELECT COUNT')) return { rows: [{ count: entries.size }] };
				if (sql.startsWith('INSERT INTO qase_memory_entries')) {
					const row = { id: values[0], key: values[4], value: values[5], scope: values[6], kind: values[7], created_at: new Date(), updated_at: new Date() };
					entries.set(row.key, row);
					return { rows: [row] };
				}
				throw new Error(`Unexpected query: ${sql}`);
			},
			release() { released++; }
		};
	} };
	return { auth: createPostgresAuthService({ pool, tenantContext: DEFAULT_TENANT_CONTEXT }), entries, released: () => released };
}

test('concurrent new memory entries cannot exceed the account quota', async () => {
	const { auth, entries, released } = fixture();
	const results = await Promise.allSettled(['first', 'second'].map(key => auth.putMemory('account', { key, value: 'A preference' })));
	assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
	assert.equal(results.find(result => result.status === 'rejected')?.reason.code, 'memory_limit');
	assert.equal(entries.size, 100);
	await auth.putMemory('account', { key: 'item0', value: 'Updated preference' });
	assert.equal(entries.size, 100);
	assert.equal(entries.get('item0').value, 'Updated preference');
	assert.equal(released(), 3);
});

test('memory writes require a profile in the selected tenant and project', async () => {
	const { auth, entries, released } = fixture({ accountExists: false });
	await assert.rejects(auth.putMemory('account', { key: 'first', value: 'A preference' }), error => error.code === 'not_found');
	assert.equal(entries.size, 99);
	assert.equal(released(), 1);
});
