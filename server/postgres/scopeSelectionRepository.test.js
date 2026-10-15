import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createPostgresRunRepository } from './runRepository.js';

const here = dirname(fileURLToPath(import.meta.url));
const RUN_ID = 'fb13e42d-9f18-4ca1-9da4-60a3be3f0863';
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const TENANT = Object.freeze(Object.freeze({
	organizationId: '11111111-1111-4111-8111-111111111111',
	organizationSlug: 'qase-local',
	organizationName: 'Qase Local',
	projectId: '22222222-2222-4222-8222-222222222222',
	projectSlug: 'default-project',
	projectName: 'Default Project',
	actorUserId: '33333333-3333-4333-8333-333333333333',
	actorEmail: 'owner@example.com',
	actorName: 'Qase Owner',
	actorRole: 'owner'
}));

function sqlText(value) {
	return String(value).replace(/\s+/g, ' ').trim();
}

function scriptedPool(handler = () => ({ rows: [], rowCount: 0 })) {
	const calls = [];
	const client = {
		async query(text, params = []) {
			const call = { text: sqlText(text), params };
			calls.push(call);
			return await handler(call, calls) ?? { rows: [], rowCount: 0 };
		},
		release() {}
	};
	const pool = {
		async connect() { return client; },
		async end() {}
	};
	return { pool, calls };
}

test('migration 035 adds scope_selection as a jsonb array column', () => {
	const sql = readFileSync(join(here, 'migrations', '035_run_scope_selection.sql'), 'utf8');
	assert.match(sql, /ADD COLUMN IF NOT EXISTS scope_selection jsonb/);
	assert.match(sql, /qa_runs_scope_selection_values/);
	assert.match(sql, /CHECK \(scope_selection IS NULL OR jsonb_typeof\(scope_selection\) = 'array'\)/);
});

test('create binds the whitelisted scope selection after cohort', async () => {
	const fake = scriptedPool(call => call.text.startsWith('INSERT INTO qa_runs')
		? { rows: [{ lock_version: '0', updated_at: new Date(NOW), next_event_sequence: 2 }], rowCount: 1 }
		: { rows: [], rowCount: 1 });
	const repository = createPostgresRunRepository({ pool: fake.pool, tenantContext: TENANT, now: () => NOW });
	await repository.create({
		id: RUN_ID,
		title: 'Scoped run',
		createdAt: NOW - 1000,
		updatedAt: NOW,
		status: 'idle',
		mode: 'qa',
		scopeSelection: ['desktop-layout', 'ui-consistency', 'junk-value'],
		messages: [],
		activities: [],
		todos: [],
		findings: [],
		secretNames: [],
		ownerUserId: TENANT.actorUserId
	}, { type: 'run.created', payload: {} });

	const insert = fake.calls.find(call => call.text.startsWith('INSERT INTO qa_runs'));
	assert.match(insert.text, /cohort, scope_selection/);
	assert.deepEqual(JSON.parse(insert.params[23]), ['desktop-layout', 'ui-consistency'], 'junk dropped, order kept');
});

test('save updates scope_selection ($38) and clears it for legacy sessions', async () => {
	const fake = scriptedPool(call => call.text.startsWith('UPDATE qa_runs')
		? { rows: [{ lock_version: '1', updated_at: new Date(NOW), next_event_sequence: 1 }], rowCount: 1 }
		: { rows: [], rowCount: 1 });
	const repository = createPostgresRunRepository({ pool: fake.pool, tenantContext: TENANT, now: () => NOW });

	await repository.save({
		id: RUN_ID,
		title: 'Scoped run',
		createdAt: NOW - 1000,
		updatedAt: NOW,
		status: 'running',
		mode: 'qa',
		scopeSelection: ['forms'],
		messages: [],
		activities: [],
		todos: [],
		findings: [],
		secretNames: []
	}, { expectedVersion: 0 });
	let update = fake.calls.find(call => call.text.startsWith('UPDATE qa_runs'));
	assert.match(update.text, /scope_selection = \$38/);
	assert.equal(update.params[37], '["forms"]');

	fake.calls.length = 0;
	await repository.save({
		id: RUN_ID,
		title: 'Legacy run',
		createdAt: NOW - 1000,
		updatedAt: NOW,
		status: 'running',
		mode: 'qa',
		messages: [],
		activities: [],
		todos: [],
		findings: [],
		secretNames: []
	}, { expectedVersion: 1 });
	update = fake.calls.find(call => call.text.startsWith('UPDATE qa_runs'));
	assert.equal(update.params[37], null, 'no scope selection persists as NULL');
});

test('hydrateRun maps scope_selection back onto the session', async () => {
	const fake = scriptedPool(call => /FROM qa_runs WHERE/.test(call.text)
		? { rows: [{ id: RUN_ID, title: 'Scoped', status: 'done', run_mode: 'qa', target_url: null,
			created_by_user_id: TENANT.actorUserId, scope_selection: JSON.stringify(['forms', 'browser-compatibility']),
			created_at: new Date(NOW - 1000), updated_at: new Date(NOW), lock_version: 1,
			secret_names: [], message_count: 0, finding_count: 0, next_event_sequence: 1 }] }
		: { rows: [], rowCount: 0 });
	const repository = createPostgresRunRepository({ pool: fake.pool, tenantContext: TENANT, now: () => NOW });
	const hydrated = await repository.get(RUN_ID);
	assert.deepEqual(hydrated.session.scopeSelection, ['forms', 'browser-compatibility']);
});

