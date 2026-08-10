import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	RunVersionConflictError,
	createPostgresRunRepository
} from './runRepository.js';

const TENANT = Object.freeze({
	organizationId: '4a7f5cf0-813d-4e3c-8d5d-4b4b9fc88c01',
	organizationSlug: 'qase-local',
	organizationName: 'Qase Local',
	projectId: '4a7f5cf0-813d-4e3c-8d5d-4b4b9fc88c02',
	projectSlug: 'default-project',
	projectName: 'Default Project',
	actorUserId: '4a7f5cf0-813d-4e3c-8d5d-4b4b9fc88c03',
	actorEmail: 'owner@example.com',
	actorName: 'Qase Owner',
	actorRole: 'owner'
});
const OTHER_TENANT = Object.freeze({
	organizationId: 'c21e52a3-1211-4efc-8ea7-8bb4d0aa93d1',
	organizationSlug: 'other-org',
	organizationName: 'Other Org',
	projectId: '8e83ab2e-40c8-42fd-a069-504c4265487d',
	projectSlug: 'other-project',
	projectName: 'Other Project',
	actorUserId: '9524d3b1-cfa8-413d-a627-840ad2355639',
	actorEmail: 'other@example.com',
	actorName: 'Other Owner',
	actorRole: 'owner'
});

const RUN_ID = 'fb13e42d-9f18-4ca1-9da4-60a3be3f0863';
const MESSAGE_ID = '34f1f4eb-e914-4eb7-a8df-b13c1215d42f';
const FINDING_ID = '0d9156f8-b0f3-4f35-ae55-74070310de64';
const NOW = Date.parse('2026-08-06T10:00:00.000Z');

function sqlText(value) {
	return String(value).replace(/\s+/g, ' ').trim();
}

function scriptedPool(handler = () => ({ rows: [], rowCount: 0 })) {
	const calls = [];
	const state = { connectCalls: 0, releases: 0, endCalls: 0 };
	const client = {
		async query(text, params = []) {
			const call = { text: sqlText(text), params };
			calls.push(call);
			const result = await handler(call, calls);
			return result ?? { rows: [], rowCount: 0 };
		},
		release() {
			state.releases++;
		}
	};
	const pool = {
		async connect() {
			state.connectCalls++;
			return client;
		},
		async end() {
			state.endCalls++;
		}
	};
	return { pool, calls, state };
}

function session(overrides = {}) {
	return {
		id: RUN_ID,
		title: 'studio.drytis.ai',
		createdAt: NOW - 1_000,
		updatedAt: NOW,
		status: 'done',
		targetUrl: 'https://studio.drytis.ai/',
		pendingQuestion: undefined,
		contextUsage: { used: 12, limit: 100 },
		secretNames: ['QA_PASSWORD'],
		messages: [{ id: MESSAGE_ID, ts: NOW - 900, role: 'user', text: 'Test this page.' }],
		activities: [{ id: 'tool-1', ts: NOW - 800, type: 'tool', label: 'Opened page', status: 'done' }],
		todos: [{ text: 'Open the page', status: 'completed' }],
		findings: [{
			id: FINDING_ID,
			ts: NOW - 700,
			title: 'Broken action',
			severity: 'high',
			category: 'forms',
			url: 'https://studio.drytis.ai/form',
			steps: ['Open form', 'Submit'],
			expected: 'Saved',
			actual: 'Failed'
		}],
		report: {
			ts: NOW - 600,
			verdict: 'fail',
			summary: 'A core action failed.',
			covered: ['forms'],
			notCovered: [],
			recommendations: ['Fix submit'],
			targetUrl: 'https://studio.drytis.ai/',
			findings: 1,
			bySeverity: { high: 1 }
		},
		...overrides
	};
}

test('repository requires a frozen trusted tenant context', () => {
	const { pool } = scriptedPool();
	assert.throws(
		() => createPostgresRunRepository({ pool, tenantContext: { ...TENANT } }),
		/frozen trusted tenant context/
	);
	assert.throws(
		() => createPostgresRunRepository({
			pool,
			tenantContext: Object.freeze({ ...TENANT, request: {} })
		}),
		/rejects request-supplied tenant context/
	);
});

test('bootstrap uses transaction-local scope and creates owner tenancy in one transaction', async () => {
	const fake = scriptedPool();
	const repository = createPostgresRunRepository({ pool: fake.pool, tenantContext: TENANT, now: () => NOW });
	const result = await repository.bootstrapTenant();

	assert.deepEqual(result, {
		ready: true,
		organizationId: TENANT.organizationId,
		projectId: TENANT.projectId,
		actorUserId: TENANT.actorUserId
	});
	assert.equal(fake.calls[0].text, 'BEGIN');
	assert.match(fake.calls[1].text, /set_config\('qase\.organization_id'/);
	assert.deepEqual(fake.calls[1].params, [TENANT.organizationId, TENANT.projectId]);
	assert.match(fake.calls[2].text, /INSERT INTO organizations/);
	assert.match(fake.calls[3].text, /INSERT INTO users/);
	assert.match(fake.calls[4].text, /INSERT INTO organization_memberships/);
	assert.match(fake.calls[5].text, /INSERT INTO projects/);
	assert.equal(fake.calls.at(-1).text, 'COMMIT');
	assert.equal(fake.state.releases, 1);
});

test('create replaces normalized children and commits its durable event before success', async () => {
	const fake = scriptedPool(call => {
		if (call.text.startsWith('INSERT INTO qa_runs')) {
			return { rows: [{ lock_version: '0', updated_at: new Date(NOW) }], rowCount: 1 };
		}
		return { rows: [], rowCount: 1 };
	});
	const repository = createPostgresRunRepository({ pool: fake.pool, tenantContext: TENANT, now: () => NOW });
	const aggregate = session({ credentials: { QA_PASSWORD: 'must-never-be-persisted' } });
	const result = await repository.create(aggregate, {
		eventType: 'run.created',
		payload: { source: 'test' },
		actorType: 'user',
		actorUserId: TENANT.actorUserId
	});

	assert.deepEqual(result, { version: 0, updatedAt: NOW });
	const runInsert = fake.calls.find(call => call.text.startsWith('INSERT INTO qa_runs'));
	assert.deepEqual(runInsert.params.slice(0, 4), [
		RUN_ID, TENANT.organizationId, TENANT.projectId, TENANT.actorUserId
	]);
	for (const table of ['qa_messages', 'qa_activities', 'qa_plan_items', 'qa_findings', 'qa_reports']) {
		assert.ok(fake.calls.some(call => call.text.startsWith(`DELETE FROM ${table}`)), `expected ${table} replacement`);
		assert.ok(fake.calls.some(call => call.text.startsWith(`INSERT INTO ${table}`)), `expected ${table} insert`);
	}
	const eventIndex = fake.calls.findIndex(call => call.text.startsWith('INSERT INTO qa_run_events'));
	const commitIndex = fake.calls.findIndex(call => call.text === 'COMMIT');
	assert.ok(eventIndex > 0 && eventIndex < commitIndex);
	assert.equal(fake.calls[eventIndex].params[3], 1);
	assert.equal(fake.calls[eventIndex].params[6], 'user');
	assert.equal(fake.calls[eventIndex].params[7], TENANT.actorUserId);
	assert.doesNotMatch(JSON.stringify(fake.calls), /must-never-be-persisted/);
	assert.equal(fake.calls.at(-1).text, 'COMMIT');
});

test('event attribution rejects arbitrary user IDs and user IDs on agent/system events', async () => {
	const fake = scriptedPool();
	const repository = createPostgresRunRepository({ pool: fake.pool, tenantContext: TENANT, now: () => NOW });
	await assert.rejects(
		repository.create(session(), {
			eventType: 'run.created',
			actorType: 'user',
			actorUserId: '3260cc0d-65dd-49c7-974c-ce2af7a9573e'
		}),
		/trusted tenant actor/
	);
	assert.equal(fake.calls.at(-1).text, 'ROLLBACK');

	const systemFake = scriptedPool();
	const systemRepository = createPostgresRunRepository({
		pool: systemFake.pool, tenantContext: TENANT, now: () => NOW
	});
	await assert.rejects(
		systemRepository.create(session(), {
			eventType: 'run.created',
			actorType: 'agent',
			actorUserId: TENANT.actorUserId
		}),
		/cannot carry a user actor ID/
	);
	assert.equal(systemFake.calls.at(-1).text, 'ROLLBACK');

	const invalidFake = scriptedPool();
	const invalidRepository = createPostgresRunRepository({
		pool: invalidFake.pool, tenantContext: TENANT, now: () => NOW
	});
	await assert.rejects(
		invalidRepository.create(session(), { eventType: 'run.created', actorType: 'browser' }),
		/actorType must be user, agent, or system/
	);
	assert.equal(invalidFake.calls.at(-1).text, 'ROLLBACK');
});

test('save enforces optimistic lock version and rolls back without an event on conflict', async () => {
	const fake = scriptedPool(call => {
		if (call.text.startsWith('UPDATE qa_runs')) return { rows: [], rowCount: 0 };
		return { rows: [], rowCount: 0 };
	});
	const repository = createPostgresRunRepository({ pool: fake.pool, tenantContext: TENANT, now: () => NOW });

	await assert.rejects(
		repository.save(session(), { expectedVersion: 4, eventType: 'run.updated' }),
		error => error instanceof RunVersionConflictError
			&& error.runId === RUN_ID
			&& error.expectedVersion === 4
	);
	const update = fake.calls.find(call => call.text.startsWith('UPDATE qa_runs'));
	assert.deepEqual(update.params.slice(0, 3), [TENANT.organizationId, TENANT.projectId, RUN_ID]);
	assert.equal(update.params.at(-1), 4);
	assert.equal(fake.calls.some(call => call.text.startsWith('INSERT INTO qa_run_events')), false);
	assert.equal(fake.calls.at(-1).text, 'ROLLBACK');
	assert.equal(fake.state.releases, 1);
});

test('a normalized child failure rolls back the run update and always releases the client', async () => {
	const fake = scriptedPool(call => {
		if (call.text.startsWith('UPDATE qa_runs')) {
			return {
				rows: [{ lock_version: '3', updated_at: new Date(NOW), next_event_sequence: '7' }],
				rowCount: 1
			};
		}
		if (call.text.startsWith('INSERT INTO qa_findings')) throw new Error('finding insert failed');
		return { rows: [], rowCount: 1 };
	});
	const repository = createPostgresRunRepository({ pool: fake.pool, tenantContext: TENANT, now: () => NOW });

	await assert.rejects(
		repository.save(session(), { expectedVersion: 2, eventType: 'finding.created' }),
		/finding insert failed/
	);
	assert.equal(fake.calls.at(-1).text, 'ROLLBACK');
	assert.equal(fake.calls.some(call => call.text === 'COMMIT'), false);
	assert.equal(fake.state.releases, 1);
});

test('delete is tenant scoped, returns compatibility booleans, and distinguishes a version conflict', async () => {
	const deleted = scriptedPool(call => call.text.startsWith('DELETE FROM qa_runs')
		? { rows: [{ id: RUN_ID }], rowCount: 1 }
		: { rows: [], rowCount: 0 });
	const repository = createPostgresRunRepository({ pool: deleted.pool, tenantContext: TENANT });
	assert.equal(await repository.delete(RUN_ID), true);
	const deletion = deleted.calls.find(call => call.text.startsWith('DELETE FROM qa_runs'));
	assert.match(deletion.text, /organization_id = \$1 AND project_id = \$2 AND id = \$3/);
	assert.deepEqual(deletion.params, [TENANT.organizationId, TENANT.projectId, RUN_ID]);

	const stale = scriptedPool(call => {
		if (call.text.startsWith('DELETE FROM qa_runs')) return { rows: [], rowCount: 0 };
		if (call.text.startsWith('SELECT lock_version FROM qa_runs')) {
			return { rows: [{ lock_version: '9' }], rowCount: 1 };
		}
		return { rows: [], rowCount: 0 };
	});
	const staleRepository = createPostgresRunRepository({ pool: stale.pool, tenantContext: TENANT });
	await assert.rejects(
		staleRepository.delete(RUN_ID, { expectedVersion: 8 }),
		error => error instanceof RunVersionConflictError && error.expectedVersion === 8
	);
	assert.equal(stale.calls.at(-1).text, 'ROLLBACK');
});

test('loadAll hydrates the exact current aggregate shape and keeps version separate', async () => {
	const fake = scriptedPool(call => {
		if (call.text.includes('FROM qa_runs')) return { rows: [{
			id: RUN_ID,
			title: 'Hydrated run',
			target_url: 'https://example.com/',
			status: 'done',
			pending_question: null,
			context_usage: { used: 5 },
			secret_names: ['QA_USER'],
			created_at: new Date(NOW - 1_000),
			updated_at: new Date(NOW),
			lock_version: '8'
		}], rowCount: 1 };
		if (call.text.includes('FROM qa_messages')) return { rows: [{
			run_id: RUN_ID, id: MESSAGE_ID, role: 'agent', kind: 'final', content: 'Finished.', created_at: new Date(NOW - 800)
		}] };
		if (call.text.includes('FROM qa_activities')) return { rows: [{
			run_id: RUN_ID, id: 'tool-1', type: 'tool', label: 'Opened', status: 'done', created_at: new Date(NOW - 700)
		}] };
		if (call.text.includes('FROM qa_plan_items')) return { rows: [{
			run_id: RUN_ID, position: 0, text: 'Open page', status: 'completed'
		}] };
		if (call.text.includes('FROM qa_findings')) return { rows: [{
			run_id: RUN_ID, id: FINDING_ID, title: 'Issue', severity: 'high', category: 'forms',
			page_url: 'https://example.com/form', steps: ['Submit'], expected: 'Saved', actual: 'Failed', created_at: new Date(NOW - 600)
		}] };
		if (call.text.includes('FROM qa_reports')) return { rows: [{
			run_id: RUN_ID, verdict: 'fail', summary: 'Issue found', covered: ['forms'],
			not_covered: [], recommendations: ['Fix it'], target_url: 'https://example.com/',
			finding_count: '1', severity_counts: { high: 1 }, published_at: new Date(NOW - 500)
		}] };
		return { rows: [], rowCount: 0 };
	});
	const repository = createPostgresRunRepository({ pool: fake.pool, tenantContext: TENANT });
	const loaded = await repository.loadAll();

	assert.equal(loaded.length, 1);
	assert.equal(loaded[0].version, 8);
	assert.equal(Object.hasOwn(loaded[0].session, 'lockVersion'), false);
	assert.equal(loaded[0].session.messages[0].text, 'Finished.');
	assert.equal(loaded[0].session.activities[0].label, 'Opened');
	assert.deepEqual(loaded[0].session.todos, [{ text: 'Open page', status: 'completed' }]);
	assert.equal(loaded[0].session.findings[0].url, 'https://example.com/form');
	assert.equal(loaded[0].session.report.findings, 1);
	assert.deepEqual(loaded[0].session.secretNames, ['QA_USER']);
	for (const call of fake.calls.filter(entry => /FROM qa_(runs|messages|activities|plan_items|findings|reports)/.test(entry.text))) {
		assert.match(call.text, /organization_id = \$1 AND project_id = \$2/);
		assert.deepEqual(call.params.slice(0, 2), [TENANT.organizationId, TENANT.projectId]);
	}
	assert.equal(fake.calls.at(-1).text, 'COMMIT');
});

test('get and list read PostgreSQL authoritatively without crossing tenant scope', async () => {
	const row = {
		id: RUN_ID,
		title: 'Other tenant run',
		target_url: 'https://other.example/',
		status: 'idle',
		pending_question: null,
		context_usage: null,
		secret_names: [],
		created_at: new Date(NOW - 1_000),
		updated_at: new Date(NOW),
		lock_version: '2',
		message_count: '3',
		finding_count: '1'
	};
	const fake = scriptedPool(call => {
		if (call.text.includes('FROM qa_runs') && call.params[0] === OTHER_TENANT.organizationId) {
			return { rows: [row], rowCount: 1 };
		}
		return { rows: [], rowCount: 0 };
	});
	const tenantA = createPostgresRunRepository({ pool: fake.pool, tenantContext: TENANT });
	const tenantB = createPostgresRunRepository({ pool: fake.pool, tenantContext: OTHER_TENANT });

	assert.equal(await tenantA.get(RUN_ID), undefined);
	const visible = await tenantB.get(RUN_ID);
	assert.equal(visible.version, 2);
	assert.equal(visible.session.title, 'Other tenant run');
	const summaries = await tenantB.list();
	assert.deepEqual(summaries, [{
		id: RUN_ID,
		title: 'Other tenant run',
		status: 'idle',
		targetUrl: 'https://other.example/',
		createdAt: NOW - 1_000,
		updatedAt: NOW,
		findingCount: 1,
		messageCount: 3
	}]);
	const scopedRunReads = fake.calls.filter(call => call.text.includes('FROM qa_runs'));
	assert.ok(scopedRunReads.every(call => /organization_id = \$1 AND project_id = \$2/.test(call.text)));
	assert.deepEqual(scopedRunReads[0].params.slice(0, 2), [TENANT.organizationId, TENANT.projectId]);
	assert.ok(scopedRunReads.some(call => call.params[0] === OTHER_TENANT.organizationId));
	assert.match(scopedRunReads.at(-1).text, /ORDER BY updated_at DESC, id ASC/);
});

test('legacy import is idempotent and writes its marker only after every aggregate event', async () => {
	const fake = scriptedPool(call => {
		if (call.text.includes('FROM qa_legacy_imports')) return { rows: [], rowCount: 0 };
		if (call.text.startsWith('SELECT id FROM qa_runs')) return { rows: [], rowCount: 0 };
		if (call.text.startsWith('INSERT INTO qa_runs')) {
			return { rows: [{ lock_version: '0', updated_at: new Date(NOW) }], rowCount: 1 };
		}
		return { rows: [], rowCount: 1 };
	});
	const repository = createPostgresRunRepository({ pool: fake.pool, tenantContext: TENANT, now: () => NOW });
	const result = await repository.importBatch({
		sourceHash: 'abc123',
		sourcePath: '.qase/sessions.json',
		importerVersion: '1',
		runs: [session()]
	});

	assert.deepEqual(result, { alreadyImported: false, imported: 1 });
	const eventIndex = fake.calls.findIndex(call => call.text.startsWith('INSERT INTO qa_run_events'));
	const markerIndex = fake.calls.findIndex(call => call.text.startsWith('INSERT INTO qa_legacy_imports'));
	const commitIndex = fake.calls.findIndex(call => call.text === 'COMMIT');
	assert.ok(eventIndex < markerIndex && markerIndex < commitIndex);
	assert.equal(fake.calls[eventIndex].params[4], 'legacy.run_imported');
	assert.equal(fake.calls[eventIndex].params[6], 'system');
	assert.equal(fake.calls[eventIndex].params[7], null);

	const existing = scriptedPool(call => call.text.includes('FROM qa_legacy_imports')
		? { rows: [{ run_count: '1' }], rowCount: 1 }
		: { rows: [], rowCount: 0 });
	const second = createPostgresRunRepository({ pool: existing.pool, tenantContext: TENANT });
	assert.deepEqual(await second.importBatch({
		sourceHash: 'abc123', sourcePath: '.qase/sessions.json', importerVersion: '1', runs: [session()]
	}), { alreadyImported: true, imported: 0 });
	assert.equal(existing.calls.some(call => call.text.startsWith('INSERT INTO qa_runs')), false);
});

test('close is idempotent', async () => {
	const fake = scriptedPool();
	const repository = createPostgresRunRepository({ pool: fake.pool, tenantContext: TENANT });
	const first = repository.close();
	const second = repository.close();
	assert.strictEqual(first, second);
	await first;
	assert.equal(fake.state.endCalls, 1);
});
