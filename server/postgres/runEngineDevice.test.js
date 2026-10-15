import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Unit tests for Postgres engine/device parity (migration 014 +
 * runRepository write/hydrate paths + postgresServices session creation).
 * No live database: the SQL is captured through a stub pool and asserted
 * structurally, matching the "integration tests skip without
 * QASE_TEST_DATABASE_URL" convention in postgres/integration.test.js.
 */

const here = dirname(fileURLToPath(import.meta.url));

function stubPool() {
	const queries = [];
	const client = {
		query: async (text, params) => {
			queries.push({ text, params });
			// Minimal shape for insertAggregate's RETURNING clause.
			return { rows: [{ lock_version: 1, updated_at: new Date(), next_event_sequence: 2 }] };
		},
		release: () => undefined
	};
	return {
		queries,
		connect: async () => client,
		end: async () => undefined
	};
}

const TENANT = Object.freeze({
	organizationId: '00000000-0000-4000-8000-000000000001',
	organizationSlug: 'org', organizationName: 'Org',
	projectId: '00000000-0000-4000-8000-000000000002',
	projectSlug: 'proj', projectName: 'Proj',
	actorUserId: '00000000-0000-4000-8000-000000000003',
	actorEmail: 'ops@example.com', actorName: 'Ops', actorRole: 'admin'
});
const RUN_ID = '00000000-0000-4000-8000-00000000000a';

describe('migration 018_run_engine_device.sql', () => {
	const sql = readFileSync(join(here, 'migrations', '018_run_engine_device.sql'), 'utf8');

	it('adds engine, device, and device_landscape columns with safe defaults', () => {
		assert.match(sql, /ADD COLUMN engine text NOT NULL DEFAULT 'chromium'/);
		assert.match(sql, /ADD COLUMN device text NOT NULL DEFAULT 'desktop'/);
		assert.match(sql, /ADD COLUMN device_landscape boolean NOT NULL DEFAULT false/);
	});

	it('is forward-only DDL only (no drops, no deletes)', () => {
		assert.doesNotMatch(sql, /\bDROP\b/i);
		assert.doesNotMatch(sql, /\bDELETE\b/i);
		assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
	});
});

describe('runRepository persistence', () => {
	it('insertAggregate writes engine/device/device_landscape', async () => {
		const { createPostgresRunRepository } = await import('./runRepository.js');
		const pool = stubPool();
		const repository = createPostgresRunRepository({ pool, tenantContext: TENANT });
		await repository.create(
			{ id: RUN_ID, title: 'QA run', status: 'idle', mode: 'qa', engine: 'firefox', device: 'pixel-7', deviceLandscape: true, messages: [], findings: [], secretNames: [], createdAt: Date.now(), updatedAt: Date.now() },
			{ type: 'run.created' }
		);
		const insert = pool.queries.find(q => /INSERT INTO qa_runs/.test(q.text));
		assert.ok(insert, 'insert executed');
		assert.match(insert.text, /engine, device, device_landscape/);
		const paramIndex = insert.text.split(')').findIndex(part => /engine, device, device_landscape/.test(part));
		assert.ok(paramIndex >= 0, 'engine column group present in column list');
		// After the DEV merge the insert binds engine/device/device_landscape/
		// cohort at $20-$23 (after next_event_sequence, before timestamps).
		const values = insert.text.match(/VALUES \(([^)]+)\)/)[1].split(',');
		const enginePosition = values.findIndex(v => v.trim() === '$20');
		assert.ok(enginePosition >= 0, 'engine binds as $20');
		assert.equal(insert.params[19], 'firefox');
		assert.equal(insert.params[20], 'pixel-7');
		assert.equal(insert.params[21], true);
	});

	it('save updates engine/device/device_landscape alongside the aggregate', async () => {
		const { createPostgresRunRepository } = await import('./runRepository.js');
		const pool = stubPool();
		const repository = createPostgresRunRepository({ pool, tenantContext: TENANT });
		await repository.save(
			{ id: RUN_ID, title: 'QA run', status: 'running', mode: 'qa', engine: 'webkit', device: 'iphone-14', deviceLandscape: false, messages: [], findings: [], secretNames: [], createdAt: Date.now(), updatedAt: Date.now() },
			{ type: 'status', expectedVersion: 3 }
		);
		const update = pool.queries.find(q => /UPDATE qa_runs SET/.test(q.text));
		assert.ok(update, 'update executed');
		// Merged save layout: engine/device/device_landscape at $33-$35.
		assert.match(update.text, /engine = \$33, device = \$34, device_landscape = \$35/);
		assert.equal(update.params[32], 'webkit');
		assert.equal(update.params[33], 'iphone-14');
		assert.equal(update.params[34], false);
	});

	it('load queries select the new columns so hydration sees them', async () => {
		const { createPostgresRunRepository } = await import('./runRepository.js');
		const pool = stubPool();
		const repository = createPostgresRunRepository({ pool, tenantContext: TENANT });
		await repository.get(RUN_ID).catch(() => undefined);
		const selects = pool.queries.filter(q => /FROM qa_runs/.test(q.text) && /SELECT/.test(q.text));
		assert.ok(selects.length > 0);
		for (const select of selects.filter(q => /hydrate/.test('') || true)) {
			// Only aggregate reads hydrate full sessions; the guard queries
			// (lock_version-only) legitimately omit them.
			if (/engine/.test(select.text)) continue;
			assert.match(select.text, /lock_version|COUNT|1 FROM/, 'column-skipping query is a guard, not a full read');
		}
		const fullRead = pool.queries.find(q => /FROM qa_runs/.test(q.text) && q.text.includes('context_usage'));
		assert.ok(fullRead, 'full aggregate read found');
		assert.match(fullRead.text, /engine, device, device_landscape/);
	});
});

describe('runEngine / runDevice normalization', () => {
	it('accepts known engines and falls back for unknown or missing values', async () => {
		// hydrateRun is not exported; exercise normalization through the
		// repository module by importing it and reading its private helpers
		// through a hydrated row via a stub pool select.
		const { createPostgresRunRepository } = await import('./runRepository.js');
		const pool = stubPool();
		// get() returns hydrated[0]; stub a row with unknown engine values.
		const row = {
			id: RUN_ID, title: 'run', status: 'done', run_mode: 'qa',
			target_url: null, created_at: new Date(), updated_at: new Date(), lock_version: 1,
			engine: 'netscape', device: '', device_landscape: null, secret_names: null
		};
		const client = {
			query: async text => {
				if (/FROM qa_runs\s+WHERE.*id = \$3/s.test(text)) return { rows: [row] };
				return { rows: [] };
			},
			release: () => undefined
		};
		pool.connect = async () => client;
		const repository = createPostgresRunRepository({ pool, tenantContext: TENANT });
		const hydrated = await repository.get(row.id);
		assert.equal(hydrated.session.engine, 'chromium', 'unknown engine falls back to chromium');
		assert.equal(hydrated.session.device, 'desktop', 'empty device falls back to desktop');
		assert.equal(hydrated.session.deviceLandscape, false, 'null landscape is false');
	});
});

describe('migration 019_run_cohort.sql (Phase 12 cohort parity)', () => {
	const sql = readFileSync(join(here, 'migrations', '019_run_cohort.sql'), 'utf8');

	it('adds a nullable cohort column constrained to pilot/NULL', () => {
		assert.match(sql, /ADD COLUMN cohort text/);
		assert.match(sql, /CHECK \(cohort IS NULL OR cohort = 'pilot'\)/);
	});

	it('is forward-only DDL only (no drops, no deletes)', () => {
		assert.doesNotMatch(sql, /\bDROP\b/i);
		assert.doesNotMatch(sql, /\bDELETE\b/i);
		assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
	});
});

describe('runRepository cohort persistence (Phase 12)', () => {
	it('insertAggregate writes cohort ($24) alongside engine/device', async () => {
		const { createPostgresRunRepository } = await import('./runRepository.js');
		const pool = stubPool();
		const repository = createPostgresRunRepository({ pool, tenantContext: TENANT });
		await repository.create(
			{ id: RUN_ID, title: 'Pilot run', status: 'idle', mode: 'qa', engine: 'chromium', cohort: 'pilot', messages: [], findings: [], secretNames: [], createdAt: Date.now(), updatedAt: Date.now() },
			{ type: 'run.created' }
		);
		const insert = pool.queries.find(q => /INSERT INTO qa_runs/.test(q.text));
		assert.ok(insert, 'insert executed');
		assert.match(insert.text, /device_landscape, cohort/);
		assert.equal(insert.params[22], 'pilot', 'cohort binds as $23');
	});

	it('save updates cohort ($27) and null-cohort sessions stay NULL', async () => {
		const { createPostgresRunRepository } = await import('./runRepository.js');
		const pool = stubPool();
		const repository = createPostgresRunRepository({ pool, tenantContext: TENANT });
		await repository.save(
			{ id: RUN_ID, title: 'Pilot run', status: 'running', mode: 'qa', cohort: 'pilot', messages: [], findings: [], secretNames: [], createdAt: Date.now(), updatedAt: Date.now() },
			{ type: 'status', expectedVersion: 2 }
		);
		const update = pool.queries.find(q => /UPDATE qa_runs SET/.test(q.text));
		assert.ok(update);
		assert.match(update.text, /cohort = \$36/);
		assert.equal(update.params[35], 'pilot');
		// Non-pilot session normalizes to NULL, not 'undefined'.
		const pool2 = stubPool();
		const repository2 = createPostgresRunRepository({ pool: pool2, tenantContext: TENANT });
		await repository2.save(
			{ id: RUN_ID, title: 'Dev run', status: 'running', mode: 'qa', cohort: undefined, messages: [], findings: [], secretNames: [], createdAt: Date.now(), updatedAt: Date.now() },
			{ type: 'status', expectedVersion: 2 }
		);
		const update2 = pool2.queries.find(q => /UPDATE qa_runs SET/.test(q.text));
		assert.equal(update2.params[35], null);
	});

	it('hydrateRun maps the cohort column back onto the session', async () => {
		const { createPostgresRunRepository } = await import('./runRepository.js');
		const pool = stubPool();
		const row = {
			id: RUN_ID, title: 'run', status: 'done', run_mode: 'qa',
			target_url: null, created_at: new Date(), updated_at: new Date(), lock_version: 1,
			engine: 'chromium', device: 'desktop', device_landscape: false, secret_names: null,
			cohort: 'pilot'
		};
		const client = {
			query: async text => {
				if (/FROM qa_runs\s+WHERE.*id = \$3/s.test(text)) return { rows: [row] };
				return { rows: [] };
			},
			release: () => undefined
		};
		pool.connect = async () => client;
		const repository = createPostgresRunRepository({ pool, tenantContext: TENANT });
		const hydrated = await repository.get(row.id);
		assert.equal(hydrated.session.cohort, 'pilot', 'cohort survives hydration');
	});

	it('full-row SELECTs include the cohort column', async () => {
		const source = readFileSync(join(here, 'runRepository.js'), 'utf8');
		const selects = source.match(/SELECT[^;]+FROM qa_runs/g) ?? [];
		const full = selects.filter(s => s.includes('context_usage'));
		assert.ok(full.length >= 2, 'full aggregate selects exist');
		for (const s of full) assert.match(s, /cohort/, 'full select includes cohort');
	});

	it('postgresServices exposes unscoped listAll/getAny for operator review', () => {
		const source = readFileSync(join(here, '..', 'postgresServices.js'), 'utf8');
		assert.match(source, /async listAll\(options\)/);
		assert.match(source, /async getAny\(id\)/);
	});
});

describe('postgresServices.createSession carries engine/device', () => {
	it('validates and stores engine from options', async () => {
		const { __internals } = await import('../postgresServices.js').catch(() => ({ __internals: undefined }));
		// postgresServices has no exported internals; assert via the module's
		// create path using the services constructor is heavyweight. Instead
		// assert the source contract textually to stay a pure unit test.
		const source = readFileSync(join(here, '..', 'postgresServices.js'), 'utf8');
		assert.match(source, /engine: isEngineId\(options\.engine\) \? options\.engine : 'chromium'/);
		assert.match(source, /engine: isEngineId\(session\.engine\) \? session\.engine : 'chromium'/);
		assert.match(source, /import \{ isEngineId \} from '\.\/browserEngines\.js';/);
	});
});
