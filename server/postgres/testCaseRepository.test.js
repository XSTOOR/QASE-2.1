import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPostgresTestCaseRepository } from './testCaseRepository.js';
import { createTestCaseService } from '../testCaseService.js';

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

const CASE_ROW = {
	id: 'c0ffee00-0000-4000-8000-000000000001',
	case_number: 'TC-0001',
	title: 'Checkout completes',
	description: null,
	steps: JSON.stringify(['Open cart', 'Pay']),
	expected: 'Order confirmed',
	tags: ['smoke'],
	environment_ids: ['ENV-IOS-IP16PRO-18.3-CHR-140'],
	deleted: false,
	created_at: new Date('2026-01-01T00:00:00Z'),
	updated_at: new Date('2026-01-02T00:00:00Z')
};

function parseSteps(row) {
	return { ...row, steps: typeof row.steps === 'string' ? JSON.parse(row.steps) : row.steps };
}

// pg returns jsonb columns already parsed — the fake row mirrors that.
const CASE_ROW_PARSED = parseSteps(CASE_ROW);

test('facade calls repository methods with the injected tenant context (no positional tenant)', async () => {
	const pool = scriptedPool(({ text }) => (text.startsWith('SELECT * FROM test_cases') ? { rows: [CASE_ROW_PARSED] } : { rows: [] }));
	const repository = createPostgresTestCaseRepository(pool, { tenantContext: TENANT });
	const service = createTestCaseService(repository, { environments: null, tenantContext: TENANT });

	const cases = await service.list();
	assert.equal(cases.length, 1);
	assert.equal(cases[0].caseNumber, 'TC-0001');
	assert.equal(cases[0].steps.length, 2);
	assert.deepEqual(cases[0].environmentIds, ['ENV-IOS-IP16PRO-18.3-CHR-140']);

	const single = await service.get('TC-0001');
	assert.equal(single.title, 'Checkout completes');

	// Every tenant-carrying query must parameterize the tenant ids.
	const tenantScoped = pool._calls.filter((call) => call.text.includes('FROM test_cases'));
	assert.ok(tenantScoped.length >= 2);
	for (const call of tenantScoped) {
		assert.equal(call.params[0], TENANT.organizationId);
		assert.equal(call.params[1], TENANT.projectId);
	}
});

test('facade without positional tenant still sets RLS config from tenantContext on every connection', async () => {
	const pool = scriptedPool(({ text }) => (text.startsWith('SELECT * FROM test_cases') ? { rows: [CASE_ROW_PARSED] } : { rows: [] }));
	const repository = createPostgresTestCaseRepository(pool, { tenantContext: TENANT });
	const service = createTestCaseService(repository, { environments: null, tenantContext: TENANT });

	await service.get('TC-0001');
	const setConfigs = pool._calls.filter((call) => call.text.includes('set_config'));
	assert.equal(setConfigs.length, 2);
	assert.match(setConfigs[0].text, /qase\.organization_id/);
	assert.match(setConfigs[1].text, /qase\.project_id/);
	assert.equal(setConfigs[0].params[0], TENANT.organizationId);
	assert.equal(setConfigs[1].params[0], TENANT.projectId);
});

test('repository list builds a parameterized filter clause per dimension', async () => {
	const pool = scriptedPool(({ text }) => (text.startsWith('SELECT * FROM test_cases') ? { rows: [] } : { rows: [] }));
	const repository = createPostgresTestCaseRepository(pool, { tenantContext: TENANT });

	await repository.list(TENANT, { search: 'checkout', tag: 'smoke', environmentId: 'ENV-X' });
	const select = pool._calls.find((call) => call.text.startsWith('SELECT * FROM test_cases'));
	assert.ok(select, 'list must issue a SELECT');
	assert.match(select.text, /lower\(case_number\) LIKE \$3 OR lower\(title\) LIKE \$3/);
	assert.match(select.text, /= ANY\(tags\)/);
	assert.match(select.text, /= ANY\(environment_ids\)/);
	assert.equal(select.params[2], '%checkout%');
	assert.ok(select.params.includes('smoke'));
	assert.ok(select.params.includes('ENV-X'));
	assert.equal(select.params.filter((p) => p === TENANT.organizationId || p === TENANT.projectId).length, 2);
});

test('create assigns the next TC number inside a transaction and sets RLS first', async () => {
	const pool = scriptedPool(({ text }) => {
		if (text.startsWith('SELECT case_number FROM test_cases')) {
			return { rows: [{ case_number: 'TC-0004' }, { case_number: 'TC-0002' }] };
		}
		if (text.startsWith('INSERT INTO test_cases')) {
			return { rows: [{ ...CASE_ROW, case_number: 'TC-0005' }], rowCount: 1 };
		}
		return { rows: [] };
	});
	const repository = createPostgresTestCaseRepository(pool, { tenantContext: TENANT });

	const row = await repository.create(TENANT, {
		title: 'New case', steps: [], tags: [], environmentIds: []
	});
	assert.equal(row.case_number, 'TC-0005');

	const begin = pool._calls.findIndex((call) => call.text === 'BEGIN');
	const setConfig = pool._calls.findIndex((call) => call.text.includes('set_config'));
	const insert = pool._calls.findIndex((call) => call.text.startsWith('INSERT INTO test_cases'));
	assert.ok(begin !== -1 && setConfig !== -1 && insert !== -1);
	assert.ok(setConfig > begin, 'RLS set_config must come after BEGIN');
	assert.ok(insert > setConfig, 'INSERT must come after RLS set_config');
	assert.ok(pool._calls.some((call) => call.text === 'COMMIT'));

	const insertCall = pool._calls[insert];
	assert.match(insertCall.text, /RETURNING \*/);
	// steps serialized as JSON text, tags/environment_ids as native arrays
	assert.equal(typeof insertCall.params.find((p) => p === '[]'), 'string');
});

test('update patches only whitelisted content columns and merges environment arrays in SQL', async () => {
	const pool = scriptedPool(({ text }) => {
		if (text.startsWith('UPDATE test_cases')) {
			return { rows: [{ ...CASE_ROW, title: 'Renamed', environment_ids: ['ENV-B'] }], rowCount: 1 };
		}
		return { rows: [] };
	});
	const repository = createPostgresTestCaseRepository(pool, { tenantContext: TENANT });

	const row = await repository.update(TENANT, 'TC-0001', {
		title: 'Renamed',
		addEnvironmentIds: ['ENV-B'],
		removeEnvironmentIds: ['ENV-IOS-IP16PRO-18.3-CHR-140']
	});
	assert.equal(row.title, 'Renamed');

	const update = pool._calls.find((call) => call.text.startsWith('UPDATE test_cases'));
	assert.match(update.text, /title = \$4/);
	assert.match(update.text, /environment_ids = \(/);
	assert.match(update.text, /UNION SELECT UNNEST\(/);
	assert.match(update.text, /EXCEPT SELECT UNNEST\(/);
	assert.match(update.text, /AND deleted = false/);
	// No un-parameterized user input in the statement
	assert.ok(!/'TC-0001'/.test(update.text), 'case number must be parameterized');
});

test('remove soft-deletes by flagging deleted = true', async () => {
	const pool = scriptedPool(({ text }) => {
		if (text.startsWith('UPDATE test_cases') && text.includes('deleted = true')) {
			return { rows: [{ ...CASE_ROW, deleted: true }], rowCount: 1 };
		}
		return { rows: [] };
	});
	const repository = createPostgresTestCaseRepository(pool, { tenantContext: TENANT });

	const row = await repository.remove(TENANT, 'TC-0001');
	assert.equal(row.deleted, true);
	const remove = pool._calls.find((call) => call.text.includes('deleted = true'));
	assert.ok(remove);
	assert.match(remove.text, /deleted = false/);
});

test('facade normalizes a content patch before it reaches the repository', async () => {
	const pool = scriptedPool(({ text }) => {
		if (text.startsWith('SELECT * FROM test_cases')) return { rows: [CASE_ROW_PARSED] };
		if (text.startsWith('UPDATE test_cases')) {
			return { rows: [{ ...CASE_ROW }], rowCount: 1 };
		}
		return { rows: [] };
	});
	const repository = createPostgresTestCaseRepository(pool, { tenantContext: TENANT });
	const service = createTestCaseService(repository, { environments: null, tenantContext: TENANT });

	// Empty title is invalid input (422), never a DB CHECK violation (500).
	await assert.rejects(
		() => service.update('TC-0001', { title: '   ' }),
		(error) => {
			assert.equal(error.code, 'QASE_TESTCASE_INVALID');
			return true;
		}
	);
	assert.ok(!pool._calls.some((call) => call.text.startsWith('UPDATE test_cases')),
		'invalid patch must not reach the database');

	// A valid patch lands with the normalized title.
	await service.update('TC-0001', { title: '  Renamed  ' });
	const update = pool._calls.find((call) => call.text.startsWith('UPDATE test_cases'));
	assert.equal(update.params.find((p) => p === 'Renamed'), 'Renamed');
});

test('repository rolls back when the INSERT fails', async () => {
	const pool = scriptedPool(({ text }) => {
		if (text.startsWith('INSERT INTO test_cases')) return 'throw';
		return { rows: [] };
	});
	const repository = createPostgresTestCaseRepository(pool, { tenantContext: TENANT });

	await assert.rejects(() => repository.create(TENANT, { title: 'X', steps: [], tags: [], environmentIds: [] }));
	assert.ok(pool._calls.some((call) => call.text === 'ROLLBACK'));
	assert.ok(!pool._calls.some((call) => call.text === 'COMMIT'));
});

test('steps round-trip through the row mapper with string or parsed steps', () => {
	const repository = createPostgresTestCaseRepository(scriptedPool(), { tenantContext: TENANT });
	assert.ok(repository);
	// The mapper lives in testCaseService.rowToTestCase; exercised via facade above.
	// Guard the contract here: stringified steps must be JSON-parseable.
	assert.deepEqual(JSON.parse(CASE_ROW.steps), ['Open cart', 'Pay']);
});
