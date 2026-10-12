import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPostgresEnvironmentRepository, EnvironmentConflictError, EnvironmentValidationError } from './environmentRepository.js';

const TENANT = Object.freeze({
	organizationId: '4a7f5cf0-813d-4e3c-8d5d-4b4b9fc88c01',
	projectId: '4a7f5cf0-813d-4e3c-8d5d-4b4b9fc88c02'
});

function scriptedPool(handler = () => ({ rows: [], rowCount: 0 })) {
	const calls = [];
	const pool = {
		async connect() {
			const client = {
				async query(text, params) {
					calls.push({ text: String(text), params });
					const result = handler({ text: String(text), params }, calls.length);
					if (result === 'throw') throw new Error('scripted failure');
					return result ?? { rows: [], rowCount: 0 };
				},
				release() {}
			};
			return client;
		}
	};
	pool._calls = calls;
	return pool;
}

test('seed inserts every generated environment and upserts by env_id without touching active', async () => {
	const pool = scriptedPool();
	const repo = createPostgresEnvironmentRepository(pool, { tenantContext: TENANT });
	const result = await repo.seed();
	assert.equal(result.catalogVersion, '2027.03.0');
	const inserts = pool._calls.filter((call) => call.text.startsWith('INSERT INTO environments'));
	assert.ok(inserts.length >= 250, `expected hundreds of upserts, got ${inserts.length}`);
	for (const call of inserts) {
		assert.match(call.text, /ON CONFLICT \(organization_id, project_id, env_id\) DO UPDATE/);
		// active is refreshed deliberately NOT — it must not appear in the update list
		const updateList = call.text.split('DO UPDATE SET')[1].split(', updated_at')[0];
		assert.ok(!updateList.includes('active'), 'seed upsert must not reset active');
	}
	assert.equal(new Set(inserts.map((call) => call.params[3])).size, inserts.length, 'env_id must be unique per insert');
});

test('seed upserts carry a deterministic profile_id for every environment (2027.03.0 #14631)', async () => {
	const pool = scriptedPool();
	const repo = createPostgresEnvironmentRepository(pool, { tenantContext: TENANT });
	await repo.seed();
	const inserts = pool._calls.filter((call) => call.text.startsWith('INSERT INTO environments'));
	assert.ok(inserts.length >= 250);
	for (const call of inserts) {
		// profile_id is the last ENV_COLUMN — trailing param after env_id+tenant columns
		const profileId = call.params[call.params.length - 1];
		assert.match(profileId, /^[a-z0-9-]+$/, `malformed profile_id: ${profileId}`);
	}
	assert.equal(new Set(inserts.map((call) => call.params[call.params.length - 1])).size, inserts.length,
		'profile_id must be unique across the seeded matrix');
});

test('seed sets tenant RLS settings inside the transaction', async () => {
	const pool = scriptedPool();
	const repo = createPostgresEnvironmentRepository(pool, { tenantContext: TENANT });
	await repo.seed();
	const setConfigs = pool._calls.filter((call) => call.text.includes('set_config'));
	assert.equal(setConfigs.length, 2);
	assert.match(setConfigs[0].text, /qase\.organization_id/);
	assert.match(setConfigs[1].text, /qase\.project_id/);
	assert.equal(setConfigs[0].params[0], TENANT.organizationId);
	assert.equal(setConfigs[1].params[0], TENANT.projectId);
});

test('get returns the matching row and null otherwise', async () => {
	const row = { env_id: 'ENV-IOS-IP16PRO-18.3-CHR-151', device: 'iPhone 16 Pro' };
	const pool = scriptedPool(({ text }) => (text.startsWith('SELECT * FROM environments') ? { rows: [row] } : { rows: [] }));
	const repo = createPostgresEnvironmentRepository(pool, { tenantContext: TENANT });
	assert.equal(await repo.get(TENANT, 'ENV-IOS-IP16PRO-18.3-CHR-151'), row);
	const emptyPool = scriptedPool(() => ({ rows: [] }));
	const emptyRepo = createPostgresEnvironmentRepository(emptyPool, { tenantContext: TENANT });
	assert.equal(await emptyRepo.get(TENANT, 'ENV-NOPE'), null);
});

test('create validates through the catalog validator before touching the database', async () => {
	const pool = scriptedPool();
	const repo = createPostgresEnvironmentRepository(pool, { tenantContext: TENANT });
	// 2026.10 expansion: Brave is valid on macOS now — the still-invalid pair
	// is Safari on Android.
	await assert.rejects(
		() => repo.create(TENANT, { platform: 'android', device: 'Galaxy S24', osVersion: '15', browser: 'safari' }),
		(error) => {
			assert.ok(error instanceof EnvironmentValidationError);
			assert.match(error.message, /not (available|supported) on android/i);
			return true;
		}
	);
	assert.equal(pool._calls.length, 0, 'invalid input must never reach the database');
});

test('create rejects Safari on Android (Firefox on iOS is valid after the 2026.10 expansion)', async () => {
	const pool = scriptedPool(({ text }) => {
		if (text.startsWith('INSERT INTO environments')) return { rows: [{ env_id: 'created' }] };
		return { rows: [] };
	});
	const repo = createPostgresEnvironmentRepository(pool, { tenantContext: TENANT });
	await assert.rejects(
		() => repo.create(TENANT, { platform: 'android', device: 'Galaxy S24', osVersion: '15', browser: 'safari' }),
		EnvironmentValidationError
	);
	const accepted = await repo.create(TENANT, { platform: 'ios', device: 'iPhone 16 Pro', osVersion: '18.3', browser: 'firefox', browserVersion: '153' });
	assert.equal(accepted.env_id, 'created');
});

test('create rejects a Safari version that contradicts the OS version', async () => {
	const pool = scriptedPool();
	const repo = createPostgresEnvironmentRepository(pool, { tenantContext: TENANT });
	await assert.rejects(
		() => repo.create(TENANT, { platform: 'ios', device: 'iPhone 16 Pro', osVersion: '18.3', browser: 'safari', browserVersion: '17' }),
		EnvironmentValidationError
	);
});

test('create throws EnvironmentConflictError on duplicate env_id', async () => {
	const pool = scriptedPool(({ text }) => {
		if (text.startsWith('SELECT env_id')) return { rows: [{ env_id: 'exists' }] };
		return { rows: [] };
	});
	const repo = createPostgresEnvironmentRepository(pool, { tenantContext: TENANT });
	await assert.rejects(
		() => repo.create(TENANT, { platform: 'ios', device: 'iPhone 16 Pro', osVersion: '18.3', browser: 'chrome', browserVersion: '151' }),
		(error) => {
			assert.ok(error instanceof EnvironmentConflictError);
			assert.equal(error.code, 'QASE_ENVIRONMENT_CONFLICT');
			return true;
		}
	);
});

test('create inserts a well-formed record for a valid combination', async () => {
	const pool = scriptedPool(({ text }) => {
		if (text.startsWith('SELECT env_id')) return { rows: [] };
		if (text.startsWith('INSERT INTO environments')) return { rows: [{ env_id: 'created' }] };
		return { rows: [] };
	});
	const repo = createPostgresEnvironmentRepository(pool, { tenantContext: TENANT });
	const created = await repo.create(TENANT, { platform: 'ios', device: 'iPhone 16 Pro', osVersion: '18.3', browser: 'chrome', browserVersion: '151' });
	assert.equal(created.env_id, 'created');
	const insert = pool._calls.find((call) => call.text.startsWith('INSERT INTO environments'));
	assert.equal(insert.params[3], 'ENV-IOS-IP16PRO-18.3-CHR-151');
	const columns = insert.text.match(/\((id, organization_id.*?)\)\s*VALUES/s)[1];
	assert.ok(columns.includes('browserstack_capabilities'));
	assert.ok(columns.includes('is_real_device'));
});

test('update only patches whitelisted columns and never env_id', async () => {
	const pool = scriptedPool(({ text }) => {
		if (text.startsWith('UPDATE environments')) return { rows: [{ env_id: 'x', active: false }] };
		return { rows: [] };
	});
	const repo = createPostgresEnvironmentRepository(pool, { tenantContext: TENANT });
	const updated = await repo.update(TENANT, 'x', { active: false, envId: 'hacked', device: 'hacked' });
	assert.equal(updated.active, false);
	const updateCall = pool._calls.find((call) => call.text.startsWith('UPDATE environments'));
	assert.match(updateCall.text, /SET active = \$1/);
	// env_id/device may only appear in the WHERE clause, never as a SET target
	const setClause = updateCall.text.split('WHERE')[0];
	assert.ok(!setClause.includes('env_id ='), `SET clause must not assign env_id: ${setClause}`);
	assert.ok(!setClause.includes('device ='), `SET clause must not assign device: ${setClause}`);
});

test('list builds parameterized filters for every dimension', async () => {
	const pool = scriptedPool(({ text }) => (text.includes('FROM environments') ? { rows: [] } : { rows: [] }));
	const repo = createPostgresEnvironmentRepository(pool, { tenantContext: TENANT });
	await repo.list(TENANT, {
		platform: 'ios',
		osVersion: '18.3',
		browser: 'Chrome',
		browserVersion: '151',
		active: 'true'
	});
	const select = pool._calls.find((call) => call.text.includes('FROM environments') && call.text.startsWith('SELECT'));
	assert.match(select.text, /WHERE/);
	assert.match(select.text, /platform = \$\d+/);
	assert.match(select.text, /os_version = \$\d+/);
	assert.match(select.text, /browser = \$\d+/);
	assert.match(select.text, /browser_version = \$\d+/);
	assert.match(select.text, /active = \$\d+/);
	// every parameter is bound, never inlined
	for (const value of select.params) {
		assert.ok(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean');
	}
});

test('list search matches env_id / device / browser with ILIKE', async () => {
	const pool = scriptedPool(({ text }) => (text.includes('FROM environments') ? { rows: [] } : { rows: [] }));
	const repo = createPostgresEnvironmentRepository(pool, { tenantContext: TENANT });
	await repo.list(TENANT, { search: 'IP16PRO' });
	const select = pool._calls.find((call) => call.text.includes('FROM environments') && call.text.startsWith('SELECT'));
	assert.match(select.text, /env_id ILIKE \$\d+/);
	assert.ok(select.params.includes('%IP16PRO%'));
});

test('list clamps limit and offset', async () => {
	const pool = scriptedPool(({ text }) => (text.includes('FROM environments') ? { rows: [] } : { rows: [] }));
	const repo = createPostgresEnvironmentRepository(pool, { tenantContext: TENANT });
	await repo.list(TENANT, { limit: '99999', offset: '-5' });
	const select = pool._calls.find((call) => call.text.includes('LIMIT'));
	// 2027.01.0 (#14273): list cap raised 20000 → 50000; 2027.02.0 (#14420):
	// raised again to 80000 for the 38.5k-row matrix with Surface + Apple additions.
	assert.equal(select.params.at(-2), 80000);
	assert.equal(select.params.at(-1), 0);
});

test('count returns the filtered total', async () => {
	const pool = scriptedPool(({ text }) => (text.startsWith('SELECT COUNT') ? { rows: [{ count: 7 }] } : { rows: [] }));
	const repo = createPostgresEnvironmentRepository(pool, { tenantContext: TENANT });
	assert.equal(await repo.count(TENANT, { browser: 'Safari' }), 7);
});

test('seed failure rolls back the transaction', async () => {
	const failing = scriptedPool((_call, index) => {
		if (index === 3) return 'throw';
		return { rows: [], rowCount: 0 };
	});
	const repo = createPostgresEnvironmentRepository(failing, { tenantContext: TENANT });
	await assert.rejects(() => repo.seed(), /scripted failure/);
	const rollback = failing._calls.find((call) => call.text === 'ROLLBACK');
	assert.ok(rollback, 'must ROLLBACK on failure');
});

// ---------------------------------------------------------------------------
// #14275 (Phase 2): upsertProviderRow
// ---------------------------------------------------------------------------

test('upsertProviderRow rejects non-PROV envIds before touching the database', async () => {
	const pool = scriptedPool();
	const repo = createPostgresEnvironmentRepository(pool, { tenantContext: TENANT });
	await assert.rejects(
		() => repo.upsertProviderRow(TENANT, { envId: 'ENV-IOS-IP16PRO-18.3-CHR-151' }),
		EnvironmentValidationError
	);
	assert.equal(pool._calls.filter((call) => call.text.includes('INSERT INTO environments')).length, 0, 'no write attempted');
});

test('upsertProviderRow inserts new provider rows and preserves id/active on conflict', async () => {
	const pool = scriptedPool(({ text }) => {
		if (text.startsWith('SELECT id, active')) return { rows: [] };
		if (text.startsWith('INSERT INTO environments')) return { rows: [{ env_id: 'PROV-X-1', active: true }] };
		return { rows: [] };
	});
	const repo = createPostgresEnvironmentRepository(pool, { tenantContext: TENANT });
	const row = await repo.upsertProviderRow(TENANT, {
		envId: 'PROV-X-1', platform: 'android', device: 'X One', executionLevel: 'REAL_DEVICE', isRealDevice: true
	});
	assert.equal(row.env_id, 'PROV-X-1');
	const insert = pool._calls.find((call) => call.text.startsWith('INSERT INTO environments'));
	assert.ok(insert, 'insert issued');
	assert.match(insert.text, /ON CONFLICT \(organization_id, project_id, env_id\) DO UPDATE/);
	// active must NOT be a SET target on the conflict path
	const updateList = insert.text.split('DO UPDATE SET')[1].split(', updated_at')[0];
	assert.ok(!updateList.includes('active'), 'upsert must never reset active');
	assert.ok(updateList.includes('device'), 'descriptive fields refresh on conflict');

	// Existing row: id + active are preserved from the pre-read.
	const poolExisting = scriptedPool(({ text }) => {
		if (text.startsWith('SELECT id, active')) return { rows: [{ id: 'preserved-uuid', active: false }] };
		if (text.startsWith('INSERT INTO environments')) return { rows: [{ env_id: 'PROV-X-1', active: false }] };
		return { rows: [] };
	});
	const repoExisting = createPostgresEnvironmentRepository(poolExisting, { tenantContext: TENANT });
	const upserted = await repoExisting.upsertProviderRow(TENANT, { envId: 'PROV-X-1', platform: 'android' });
	assert.equal(upserted.active, false, 'operator deactivation survives provider refresh');
	const insertExisting = poolExisting._calls.find((call) => call.text.startsWith('INSERT INTO environments'));
	assert.equal(insertExisting.params[0], 'preserved-uuid', 'surrogate id preserved');
	assert.equal(insertExisting.params[4], false, 'active passed through from the preserved row');
});

test('upsertProviderRow failure rolls back the transaction', async () => {
	const pool = scriptedPool(({ text }) => {
		if (text.startsWith('INSERT INTO environments')) return 'throw';
		return { rows: [] };
	});
	const repo = createPostgresEnvironmentRepository(pool, { tenantContext: TENANT });
	await assert.rejects(
		() => repo.upsertProviderRow(TENANT, { envId: 'PROV-X-1', platform: 'android' }),
		/scripted failure/
	);
	const texts = pool._calls.map((call) => call.text);
	assert.ok(texts.includes('ROLLBACK'), 'transaction rolled back');
});

test('seed retire step never deactivates PROV- provider rows (#14275)', async () => {
	const pool = scriptedPool();
	const repo = createPostgresEnvironmentRepository(pool, { tenantContext: TENANT });
	await repo.seed();
	const retire = pool._calls.find((call) => call.text.startsWith('UPDATE environments'));
	assert.ok(retire, 'retire statement issued');
	assert.match(retire.text, /env_id NOT LIKE 'PROV-%'/, 'PROV- rows excluded from retirement');
});

test('seed upserts registry provider overlays idempotently (#14275)', async () => {
	const { registerCatalogProvider, unregisterCatalogProvider } = await import('../catalogProviderRegistry.js');
	registerCatalogProvider({
		name: 'PgSeedFake',
		slug: 'pgseedfake',
		async fetchCatalog() {
			return {
				environments: [
					{ envId: 'PGFAKE-1', executionLevel: 'REAL_DEVICE', isRealDevice: true, platform: 'android', device: 'Pg Fake', os: 'Android', osVersion: '15', browser: 'Chrome', browserCode: 'chrome', browserVersion: '151', deviceType: 'mobile' }
				],
				attestations: []
			};
		}
	});
	try {
		const pool = scriptedPool(({ text }) => {
			if (text.startsWith('SELECT id, active')) return { rows: [{ id: 'kept-uuid', active: false }] };
			if (text.startsWith('INSERT INTO environments') && text.includes('PROV-PGSEEDFAKE-')) return { rows: [{ env_id: 'PROV-PGSEEDFAKE-PGFAKE-1' }] };
			return { rows: [] };
		});
		const repo = createPostgresEnvironmentRepository(pool, { tenantContext: TENANT });
		const result = await repo.seed();
		assert.equal(result.providerRows, 1, 'provider overlay upserted during seed');
		const providerInsert = pool._calls.find((call) => call.text.includes('PROV-PGSEEDFAKE-') || (call.text.startsWith('INSERT INTO environments') && call.params[3] === 'PROV-PGSEEDFAKE-PGFAKE-1'));
		assert.ok(providerInsert, 'provider insert issued');
		assert.equal(providerInsert.params[0], 'kept-uuid', 'existing surrogate id preserved');
		assert.equal(providerInsert.params[4], false, 'operator deactivation preserved');
		const updateList = providerInsert.text.split('DO UPDATE SET')[1].split(', updated_at')[0];
		assert.ok(!updateList.includes('active'), 'seed overlay must never reset active');
	} finally {
		unregisterCatalogProvider('pgseedfake');
	}
});
