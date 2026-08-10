import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { runPostgresMigrations } from './migrations.js';
import { createPostgresExecutionQueue } from './executionQueue.js';
import {
	RunVersionConflictError,
	createPostgresRunRepository
} from './runRepository.js';

const { Pool } = pg;
const DATABASE_URL = String(process.env.QASE_TEST_DATABASE_URL ?? '').trim();
const TEST_SCHEMA_PATTERN = /^qase_it_[0-9a-f]{24}$/;

function uniqueSchema() {
	const schema = `qase_it_${randomBytes(12).toString('hex')}`;
	assert.match(schema, TEST_SCHEMA_PATTERN);
	return schema;
}

/** Identifier interpolation is restricted to the cryptographically generated schema. */
function quotedSchema(schema) {
	if (!TEST_SCHEMA_PATTERN.test(schema)) {
		throw new TypeError('Refusing to use an invalid integration-test schema identifier.');
	}
	return `"${schema}"`;
}

function scopedPool(schema) {
	assert.match(schema, TEST_SCHEMA_PATTERN);
	return new Pool({
		connectionString: DATABASE_URL,
		max: 3,
		options: `-c search_path=${schema},public`,
		application_name: 'qase-postgres-integration-test'
	});
}

function tenantContext(kind) {
	const contexts = {
		a: {
			organizationId: '8c135239-cc6d-4e29-9f31-d40755137811',
			organizationSlug: 'integration-tenant-a',
			organizationName: 'Integration Tenant A',
			projectId: '63e57ec3-5a83-4491-9706-2ce61763f7d1',
			projectSlug: 'integration-project-a',
			projectName: 'Integration Project A',
			actorUserId: '5f75d329-68f5-4599-b235-f0d47f34a4a1',
			actorEmail: 'owner-a@integration.invalid',
			actorName: 'Integration Owner A',
			actorRole: 'owner'
		},
		b: {
			organizationId: '13ebbb9c-cc2d-4d59-8b66-a1698ee01df7',
			organizationSlug: 'integration-tenant-b',
			organizationName: 'Integration Tenant B',
			projectId: '19f650a6-dace-4465-a641-e1930f8d31b4',
			projectSlug: 'integration-project-b',
			projectName: 'Integration Project B',
			actorUserId: '4e50f8f7-48e8-463b-8f5c-ac61ad9d5234',
			actorEmail: 'owner-b@integration.invalid',
			actorName: 'Integration Owner B',
			actorRole: 'owner'
		}
	};
	return Object.freeze({ ...contexts[kind] });
}

function runAggregate() {
	return {
		id: 'f24010d2-78bf-43f7-a1e1-8f127df3042c',
		title: 'Tenant A integration run',
		createdAt: 1_900_000_000_000,
		updatedAt: 1_900_000_000_000,
		status: 'idle',
		targetUrl: 'https://example.com/',
		messages: [],
		activities: [],
		findings: [],
		todos: [],
		report: undefined,
		pendingQuestion: undefined,
		contextUsage: undefined,
		secretNames: []
	};
}

test(
	'real PostgreSQL repository enforces tenant isolation, optimistic locking, and default-deny RLS',
	{ skip: !DATABASE_URL },
	async t => {
		const schema = uniqueSchema();
		const identifier = quotedSchema(schema);
		const administrationPool = new Pool({
			connectionString: DATABASE_URL,
			max: 1,
			application_name: 'qase-postgres-integration-admin'
		});
		let migrationPool;
		let tenantAPool;
		let tenantBPool;
		let tenantARepository;
		let tenantBRepository;

		t.after(async () => {
			const closures = [];
			if (tenantARepository) closures.push(tenantARepository.close());
			else if (tenantAPool) closures.push(tenantAPool.end());
			if (tenantBRepository) closures.push(tenantBRepository.close());
			else if (tenantBPool) closures.push(tenantBPool.end());
			if (migrationPool) closures.push(migrationPool.end());
			await Promise.allSettled(closures);

			try {
				// The exact identifier was validated before any interpolation.
				await administrationPool.query(`DROP SCHEMA IF EXISTS ${identifier} CASCADE`);
			} finally {
				await administrationPool.end().catch(() => undefined);
			}
		});

		await administrationPool.query(`CREATE SCHEMA ${identifier}`);
		migrationPool = scopedPool(schema);
		await runPostgresMigrations(migrationPool);

		tenantAPool = scopedPool(schema);
		tenantBPool = scopedPool(schema);
		const contextA = tenantContext('a');
		const contextB = tenantContext('b');
		assert.equal(Object.isFrozen(contextA), true);
		assert.equal(Object.isFrozen(contextB), true);

		tenantARepository = createPostgresRunRepository({
			pool: tenantAPool,
			tenantContext: contextA,
			now: () => 1_900_000_000_100
		});
		tenantBRepository = createPostgresRunRepository({
			pool: tenantBPool,
			tenantContext: contextB,
			now: () => 1_900_000_000_200
		});
		await tenantARepository.bootstrapTenant();
		await tenantBRepository.bootstrapTenant();

		const value = runAggregate();
		const created = await tenantARepository.create(value, {
			eventType: 'session',
			payload: { title: value.title }
		});
		assert.equal(created.version, 1);

		const tenantAGet = await tenantARepository.get(value.id);
		assert.equal(tenantAGet.session.id, value.id);
		assert.equal(tenantAGet.version, created.version);
		assert.deepEqual((await tenantARepository.list()).map(run => run.id), [value.id]);

		const tenantAQueue = createPostgresExecutionQueue({ pool: tenantAPool, tenantContext: contextA });
		const tenantBQueue = createPostgresExecutionQueue({ pool: tenantBPool, tenantContext: contextB });
		const queued = await tenantAQueue.enqueue({
			runId: value.id,
			requestedByUserId: contextA.actorUserId,
			turnOptions: { task: 'integration canary' }
		});
		assert.equal(queued.status, 'queued');
		assert.equal(await tenantBQueue.claim('integration-worker-b'), undefined);
		const claimed = await tenantAQueue.claim('integration-worker-a');
		assert.equal(claimed.id, queued.id);
		assert.equal(await tenantAQueue.heartbeat({
			jobId: claimed.id,
			leaseToken: claimed.leaseToken,
			workerId: 'integration-worker-a'
		}), 'leased');
		assert.equal(await tenantAQueue.complete({
			jobId: claimed.id,
			leaseToken: claimed.leaseToken,
			workerId: 'integration-worker-a'
		}), 'succeeded');

		assert.equal(await tenantBRepository.get(value.id), undefined);
		assert.deepEqual(await tenantBRepository.list(), []);

		value.updatedAt = created.updatedAt;
		value.status = 'done';
		const saved = await tenantARepository.save(value, {
			expectedVersion: created.version,
			eventType: 'status',
			payload: { status: 'done' }
		});
		assert.equal(saved.version, created.version + 1);
		const afterSave = await tenantARepository.get(value.id);
		assert.equal(afterSave.session.status, 'done');
		assert.equal(afterSave.version, saved.version);

		assert.equal(await tenantBRepository.get(value.id), undefined);
		assert.deepEqual(await tenantBRepository.list(), []);

		const stale = { ...value, status: 'error', updatedAt: saved.updatedAt };
		await assert.rejects(
			tenantARepository.save(stale, {
				expectedVersion: created.version,
				eventType: 'status',
				payload: { status: 'error' }
			}),
			error => error instanceof RunVersionConflictError
		);
		assert.equal((await tenantARepository.get(value.id)).session.status, 'done');

		// The dedicated test URL must use the same non-bypass role production uses;
		// a PostgreSQL superuser would make an RLS assertion meaningless.
		const role = await tenantAPool.query(`
			SELECT rolsuper, rolbypassrls
			FROM pg_roles
			WHERE rolname = current_user
		`);
		assert.equal(role.rows[0]?.rolsuper, false, 'QASE_TEST_DATABASE_URL must not use a superuser role');
		assert.equal(role.rows[0]?.rolbypassrls, false, 'QASE_TEST_DATABASE_URL role must not have BYPASSRLS');

		const raw = await tenantAPool.query('SELECT COUNT(*)::int AS count FROM runs');
		assert.equal(raw.rows[0].count, 0, 'forced RLS must default-deny without transaction-local tenant context');
		const rawJobs = await tenantAPool.query('SELECT COUNT(*)::int AS count FROM qa_execution_jobs');
		assert.equal(rawJobs.rows[0].count, 0, 'execution jobs must default-deny without tenant context');
	}
);
