import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import pg from 'pg';
import { loadMigrations, MIGRATIONS_DIRECTORY, runPostgresMigrations } from './migrations.js';
import { createPostgresExecutionQueue } from './executionQueue.js';
import {
	RunVersionConflictError,
	createPostgresRunRepository
} from './runRepository.js';
import {
	PURGE_ACKNOWLEDGEMENT,
	createPostgresRetentionRepository
} from './retentionRepository.js';
import { createSqaState } from '../sqaService.js';
import { createFounderActions } from '../founderActions.js';

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

/**
 * Creates one expired post-hold candidate using PostgreSQL's transaction clock.
 * The fixture uses ordinary tenant RLS and lifecycle transitions; it never
 * disables the immutable lifecycle triggers or relies on the test host clock.
 */
async function createExpiredPostHoldFixture(pool, context) {
	const runId = 'f24010d2-78bf-43f7-a1e1-8f127df3042d';
	const requestId = 'a24010d2-78bf-43f7-a1e1-8f127df3042d';
	const leaseToken = 'b24010d2-78bf-43f7-a1e1-8f127df3042d';
	const referenceId = 'TEST-CASE-EXPIRED';
	const policyVersion = 'qase-data-lifecycle/v1';
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query(
			"SELECT set_config('qase.organization_id', $1, true), set_config('qase.project_id', $2, true)",
			[context.organizationId, context.projectId]
		);
		await client.query(
			`INSERT INTO qa_runs (
				id, organization_id, project_id, created_by_user_id, title, status,
				status_detail, created_at, updated_at, completed_at, deleted_at, deleted_by_user_id
			) VALUES (
				$1, $2, $3, $4, 'Expired post-hold integration fixture', 'done',
				'Deleted by integration fixture.',
				CURRENT_TIMESTAMP - INTERVAL '32 days',
				CURRENT_TIMESTAMP - INTERVAL '31 days',
				CURRENT_TIMESTAMP - INTERVAL '31 days',
				CURRENT_TIMESTAMP - INTERVAL '31 days', $4
			)`,
			[runId, context.organizationId, context.projectId, context.actorUserId]
		);
		await client.query(
			`INSERT INTO qase_lifecycle_requests (
				id, organization_id, project_id, subject_type, subject_id, action,
				idempotency_key, requested_by_actor_type, requested_by_user_id,
				reason_code, reference_id, policy_version, purge_after, available_at,
				created_at, updated_at
			) VALUES (
				$1, $2, $3, 'run', $4, 'soft_delete', $5, 'user', $6,
				'integration_expired_fixture', $7, $8,
				CURRENT_TIMESTAMP - INTERVAL '31 days',
				CURRENT_TIMESTAMP - INTERVAL '31 days',
				CURRENT_TIMESTAMP - INTERVAL '31 days',
				CURRENT_TIMESTAMP - INTERVAL '31 days'
			)`,
			[
				requestId, context.organizationId, context.projectId, runId,
				`run:${runId}:soft-delete-fixture`, context.actorUserId,
				referenceId, policyVersion
			]
		);
		await client.query(
			`UPDATE qase_lifecycle_requests SET status = 'approved',
				updated_at = CURRENT_TIMESTAMP - INTERVAL '31 days'
			 WHERE organization_id = $1 AND project_id = $2 AND id = $3 AND status = 'requested'`,
			[context.organizationId, context.projectId, requestId]
		);
		await client.query(
			`UPDATE qase_lifecycle_requests SET status = 'processing', attempts = attempts + 1,
				lease_owner = 'integration-fixture', lease_token = $4,
				lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '31 days' + INTERVAL '5 minutes',
				started_at = CURRENT_TIMESTAMP - INTERVAL '31 days',
				updated_at = CURRENT_TIMESTAMP - INTERVAL '31 days'
			 WHERE organization_id = $1 AND project_id = $2 AND id = $3 AND status = 'approved'`,
			[context.organizationId, context.projectId, requestId, leaseToken]
		);
		await client.query(
			`UPDATE qase_lifecycle_requests SET status = 'completed',
				finished_at = CURRENT_TIMESTAMP - INTERVAL '31 days',
				lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
				updated_at = CURRENT_TIMESTAMP - INTERVAL '31 days'
			 WHERE organization_id = $1 AND project_id = $2 AND id = $3 AND status = 'processing'`,
			[context.organizationId, context.projectId, requestId]
		);
		await client.query(
			`INSERT INTO qase_run_cleanup (
				organization_id, project_id, run_id, requested_at,
				request_reference_id, policy_version
			) VALUES (
				$1, $2, $3, CURRENT_TIMESTAMP - INTERVAL '31 days', $4, $5
			)`,
			[
				context.organizationId, context.projectId, runId,
				`cleanup/${requestId}`, policyVersion
			]
		);
		await client.query(
			`UPDATE qase_run_cleanup SET status = 'completed', attempts = attempts + 1,
				last_attempt_at = CURRENT_TIMESTAMP - INTERVAL '31 days',
				completed_at = CURRENT_TIMESTAMP - INTERVAL '31 days',
				attestation_reference_id = $4
			 WHERE organization_id = $1 AND project_id = $2 AND run_id = $3 AND status = 'pending'`,
			[context.organizationId, context.projectId, runId, referenceId]
		);
		await client.query(
			`INSERT INTO qase_lifecycle_events (
				organization_id, project_id, subject_type, subject_id, action, event_type,
				from_status, actor_type, actor_user_id, reason_code, reference_id,
				resource_counts, policy_version, created_at
			) VALUES (
				$1, $2, 'run', $3, 'legal_hold', 'legal_hold.released', 'held',
				'user', $4, 'integration_hold_released', $5, '{}'::jsonb, $6,
				CURRENT_TIMESTAMP - INTERVAL '31 days'
			)`,
			[
				context.organizationId, context.projectId, runId,
				context.actorUserId, referenceId, policyVersion
			]
		);
		await client.query('COMMIT');
		return runId;
	} catch (error) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
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
		const legacyDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'qase-founder-upgrade-'));
		t.after(async () => {
			assert.equal(path.dirname(path.resolve(legacyDirectory)), path.resolve(os.tmpdir()));
			assert.ok(path.basename(legacyDirectory).startsWith('qase-founder-upgrade-'));
			await fs.rm(legacyDirectory, { recursive: true, force: true });
		});
		for (const migration of await loadMigrations()) if (migration.version < 44) await fs.copyFile(path.join(MIGRATIONS_DIRECTORY, migration.filename), path.join(legacyDirectory, migration.filename));
		assert.equal((await runPostgresMigrations(migrationPool, { directory: legacyDirectory })).currentVersion, 43);

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
		const legacyFounder = { schemaVersion: 1, ownerUserId: contextA.actorUserId, targetUrl: 'https://fixture.invalid/', recommendationSet: { setVersion: 1, generatedAt: '2026-11-07T00:00:00.000Z', recommendations: [{ id: 'legacy-rec', title: 'Preserve legacy work' }] }, selections: ['legacy-rec'] };
		await tenantARepository.saveFounderProjectState(legacyFounder);
		const upgrade = await runPostgresMigrations(migrationPool);
		assert.deepEqual(upgrade.applied.map(item => item.version), [44]);
		assert.deepEqual(await tenantARepository.getFounderProjectState(), legacyFounder, 'Migration 044 preserves the exact legacy selection and report.');

		await t.test('Founder actions serialize across separate PostgreSQL replicas and preserve another report during delivery', { timeout: 30_000 }, async subtest => {
			const replicaPool = scopedPool(schema);
			const replica = createPostgresRunRepository({ pool: replicaPool, tenantContext: contextA });
			subtest.after(() => replica.close());
			let enter, release, deliveries = 0;
			const entered = new Promise(resolve => { enter = resolve; });
			const gate = new Promise(resolve => { release = resolve; });
			subtest.after(() => release());
			const deliveryClient = { async deliver() { deliveries++; enter(); await gate; return { status: 202, body: { jobId: 'postgres-fixture-job' } }; } };
			const makeActions = repository => createFounderActions({ projectId: contextA.projectId, deliveryClient, backend: {
				get: repository.getFounderProjectState, save: repository.saveFounderProjectState, update: repository.updateFounderProjectState
			} });
			const first = makeActions(tenantARepository), second = makeActions(replica);
			const source = name => ({ id: randomUUID(), mode: 'founder', ownerUserId: contextA.actorUserId, founder: {
				finalizedAt: '2026-11-08T00:00:00.000Z', scope: { target: { url: 'https://fixture.invalid/' }, productContext: { primaryGoal: name } },
				report: { generatedAt: '2026-11-08T00:00:00.000Z', recommendationSet: { setVersion: 1, generatedAt: '2026-11-08T00:00:00.000Z' }, recommendations: [{ id: 'rec-1', title: name }, { id: 'rec-2', title: `${name} second` }] }
			} });
			const a = source('First report'), b = source('Other report');
			const request = (state, ids = state.selections) => ({ reviewKey: state.reviewKey, expectedRevision: state.revision, selectedRecommendationIds: ids });
			const start = await first.read(a);
			const raced = await Promise.allSettled([first.select(a, request(start, ['rec-1'])), second.select(a, request(start, ['rec-2']))]);
			assert.equal(raced.filter(item => item.status === 'fulfilled').length, 1);
			assert.equal(raced.find(item => item.status === 'rejected').reason.status, 409);
			const saved = await second.read(a), sending = first.send(a, request(saved));
			await entered;
			await assert.rejects(second.send(a, request(saved)), error => error.status === 409);
			await second.publish(b);
			await second.select(b, request(await second.read(b), ['rec-2']));
			release(); const delivered = await sending;
			assert.equal(delivered.state.handoff.reference, 'postgres-fixture-job');
			assert.equal(deliveries, 1); assert.deepEqual((await second.read(b)).selections, ['rec-2']);
			assert.equal((await second.send(a, request(saved))).deduplicated, true); assert.equal(deliveries, 1);
			assert.equal(await tenantBRepository.getFounderProjectState(), undefined, 'Another project cannot read Founder actions.');
			assert.equal((await tenantAPool.query('SELECT COUNT(*)::int AS count FROM founder_project_state')).rows[0].count, 0, 'Founder state defaults to deny without a transaction tenant.');
		});

		const value = runAggregate();
		const created = await tenantARepository.create(value, {
			eventType: 'session',
			payload: { title: value.title }
		});
		assert.equal(created.version, 0, 'new aggregates start at lock version zero');

		const tenantAGet = await tenantARepository.get(value.id);
		assert.equal(tenantAGet.session.id, value.id);
		assert.equal(tenantAGet.version, created.version);
		assert.deepEqual((await tenantARepository.list()).map(run => run.id), [value.id]);

		const sqaRun = {
			...runAggregate(),
			id: 'f24010d2-78bf-43f7-a1e1-8f127df3042e',
			title: 'Tenant A SQA persistence canary',
			mode: 'sqa',
			sqa: createSqaState({
				authorizationConfirmed: true,
				profiles: ['core'],
				attributes: ['web_application'],
				target: { name: 'Integration canary', release: '2026.08', environment: 'test' }
			})
		};
		const sqaCreated = await tenantARepository.create(sqaRun, {
			eventType: 'sqa.created',
			payload: { catalogVersion: sqaRun.sqa.scope.catalogVersion }
		});
		const sqaLoaded = await tenantARepository.get(sqaRun.id);
		assert.equal(sqaLoaded.session.mode, 'sqa');
		assert.equal(sqaLoaded.session.sqa.scope.catalogVersion, sqaRun.sqa.scope.catalogVersion);
		assert.equal(sqaLoaded.session.sqa.assessment, undefined);
		sqaLoaded.session.sqa.execution={version:1,strategy:'qualified-opus-jev-v1',actions:[{id:'executed',status:'done'}],modelBudget:{roles:{reasoner:{inputTokens:123,outputTokens:4,reservations:[]}}}};
		const reasoningSave=await tenantARepository.save(sqaLoaded.session,{expectedVersion:sqaLoaded.version,eventType:'mode.reasoning',payload:{}});
		assert.deepEqual((await tenantARepository.get(sqaRun.id)).session.sqa.execution,sqaLoaded.session.sqa.execution,'reasoning checkpoint and exact accounting survive real hydration');
		assert.equal(await tenantBRepository.get(sqaRun.id), undefined);
		assert.equal(await tenantARepository.delete(sqaRun.id, {
			expectedVersion: reasoningSave.version,
			eventType: 'run.deleted',
			actorType: 'user',
			actorUserId: contextA.actorUserId
		}), true);

		const drytisRun = {
			...runAggregate(),
			id: 'd1ad1965-6709-4d96-a9f5-b973f397dd46',
			title: 'Tenant A Drytis integration canary',
			mode: 'qa',
			drytisIntegration: {
				schemaVersion: '2026-08-1',
				externalReviewId: 'd1ad1965-6709-4d96-a9f5-b973f397dd46',
				project: { id: contextA.projectId, name: 'Integration canary', revision: 'revision-1' },
				requestedChecks: { blackBox: false, whiteBox: true },
				whiteBox: { analysis: { analysisId: 'analysis-canary', snapshotSha256: 'a'.repeat(64) } },
				blackBox: { status: 'not_requested', attempts: 0 },
				createdAt: '2026-08-19T00:00:00.000Z',
				updatedAt: '2026-08-19T00:00:00.000Z'
			}
		};
		const drytisCreated = await tenantARepository.create(drytisRun, {
			eventType: 'drytis.review.created',
			payload: { externalReviewId: drytisRun.id }
		});
		const drytisLoaded = await tenantARepository.get(drytisRun.id);
		assert.equal(drytisLoaded.session.mode, 'qa');
		assert.deepEqual(drytisLoaded.session.drytisIntegration, drytisRun.drytisIntegration);
		assert.equal(await tenantBRepository.get(drytisRun.id), undefined);
		assert.equal(await tenantARepository.delete(drytisRun.id, {
			expectedVersion: drytisCreated.version,
			eventType: 'run.deleted',
			actorType: 'user',
			actorUserId: contextA.actorUserId
		}), true);

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

		await t.test('a crashed claiming process is fenced and a restart retains the durable checkpoint', async () => {
			await tenantAQueue.enqueue({runId:value.id,requestedByUserId:contextA.actorUserId,turnOptions:{task:'restart fixture'}});
			const child = spawn(process.execPath,['--input-type=module','-e',`
				import pg from 'pg';
				import {createPostgresExecutionQueue} from ${JSON.stringify(new URL('./executionQueue.js',import.meta.url).href)};
				import {createPostgresRunRepository} from ${JSON.stringify(new URL('./runRepository.js',import.meta.url).href)};
				const tenant=Object.freeze(JSON.parse(process.env.QASE_RESTART_TENANT));
				const pool=new pg.Pool({connectionString:process.env.QASE_TEST_DATABASE_URL,options:process.env.QASE_RESTART_OPTIONS});
				const queue=createPostgresExecutionQueue({pool,tenantContext:tenant});
				const job=await queue.claim('crash-fixture',5000);
				const repo=createPostgresRunRepository({pool,tenantContext:tenant});
				const saved=await repo.get(job.runId);saved.session.contextUsage={fixtureCompletedActionIds:['already-executed'],providerReportedTokens:123};
				await repo.save(saved.session,{expectedVersion:saved.version,eventType:'context',payload:{}});
				process.send(job);setInterval(()=>{},1000);
			`],{cwd:process.cwd(),env:{...process.env,QASE_RESTART_TENANT:JSON.stringify(contextA),QASE_RESTART_OPTIONS:`-c search_path=${schema},public`},stdio:['ignore','ignore','pipe','ipc']});
			let childError='';child.stderr.on('data',data=>childError+=data);
			const claimed=await Promise.race([once(child,'message').then(([job])=>job),once(child,'exit').then(()=>{throw new Error(`Crash fixture exited before claim: ${childError}`);})]);
			const exited=once(child,'exit');child.kill('SIGKILL');await exited;
			assert.equal(await tenantAQueue.claim('too-early-restart',5000),undefined);
			await new Promise(resolve=>setTimeout(resolve,Math.max(1,claimed.leaseExpiresAt-Date.now()+50)));
			const competing=await Promise.all([tenantAQueue.claim('restart-a',5000),tenantAQueue.claim('restart-b',5000)]);
			assert.equal(competing.filter(Boolean).length,1);
			const recovered=competing.find(Boolean);assert.equal(recovered.id,claimed.id);assert.equal(recovered.attempts,2);
			assert.notEqual(recovered.leaseToken,claimed.leaseToken);
			assert.equal(await tenantAQueue.complete({jobId:claimed.id,leaseToken:claimed.leaseToken,workerId:'crash-fixture'}),undefined);
			const checkpoint=await tenantARepository.get(value.id);
			assert.deepEqual(checkpoint.session.contextUsage.fixtureCompletedActionIds,['already-executed']);
			assert.equal(checkpoint.session.contextUsage.providerReportedTokens,123);
			assert.equal(await tenantAQueue.cancelRun(value.id),'cancel_requested');
			assert.equal(await tenantAQueue.heartbeat({jobId:recovered.id,leaseToken:recovered.leaseToken,workerId:recovered.leaseOwner}),'cancel_requested');
			assert.equal(await tenantAQueue.complete({jobId:recovered.id,leaseToken:recovered.leaseToken,workerId:recovered.leaseOwner}),'cancelled');
			// The child saved a checkpoint. Use its authoritative new version below.
			created.version=checkpoint.version;
		});

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

		await t.test('concurrent publication has one winner and a severed transaction rolls back',async()=>{
			const before=await tenantARepository.get(value.id);
			const make=()=>({...structuredClone(before.session),report:{ts:1_900_000_000_300,verdict:'partial',summary:'Synthetic transaction fixture',covered:[],notCovered:['Fixture only'],recommendations:[]}});
			const attempts=await Promise.allSettled([tenantARepository.save(make(),{expectedVersion:before.version,eventType:'report',payload:{}}),tenantARepository.save(make(),{expectedVersion:before.version,eventType:'report',payload:{}})]);
			assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
			assert.ok(attempts.find(r=>r.status==='rejected').reason instanceof RunVersionConflictError);
			const persisted=await tenantARepository.get(value.id);assert.equal(persisted.session.report.summary,'Synthetic transaction fixture');
			const connection=await tenantAPool.connect();connection.on('error',()=>{});
			try{
				await connection.query('BEGIN');
				await connection.query("SELECT set_config('qase.organization_id',$1,true),set_config('qase.project_id',$2,true)",[contextA.organizationId,contextA.projectId]);
				const pid=(await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
				await connection.query('UPDATE qa_runs SET title=$2 WHERE id=$1',[value.id,'MUST ROLLBACK']);
				const interrupted=connection.query('SELECT pg_sleep(10)').catch(error=>error);
				assert.equal((await tenantAPool.query('SELECT pg_terminate_backend($1) AS stopped',[pid])).rows[0].stopped,true);
				assert.ok(await interrupted instanceof Error);
			}finally{connection.release(true);}
			const recovered=await tenantARepository.get(value.id);assert.equal(recovered.session.title,value.title);assert.deepEqual(recovered.session.report,persisted.session.report);
			saved.version=recovered.version;
		});

		const retentionA = createPostgresRetentionRepository({
			pool: tenantAPool,
			tenantContext: contextA
		});
		const retentionB = createPostgresRetentionRepository({
			pool: tenantBPool,
			tenantContext: contextB
		});
		assert.equal((await retentionA.placeHold({
			runId: value.id,
			reasonCode: 'integration_hold',
			referenceId: 'TEST-CASE-10',
			actorType: 'user',
			actorUserId: contextA.actorUserId,
			policyVersion: 'integration-v1'
		})).placed, true);
		assert.equal(await tenantARepository.delete(value.id, {
			expectedVersion: saved.version,
			eventType: 'run.deleted',
			actorType: 'user',
			actorUserId: contextA.actorUserId
		}), true);
		assert.equal(await tenantARepository.get(value.id), undefined);
		assert.equal((await tenantARepository.recordCleanup(value.id, {
			status: 'completed',
			actorType: 'worker',
			referenceId: 'TEST-CASE-10'
		})).recorded, true,
		'purge must remain ineligible until external cleanup is durably recorded');

		assert.equal((await retentionA.previewRuns({ retentionDays: 30 })).candidateCount, 0,
			'an active hold must block the deleted run');
		assert.equal((await retentionA.releaseHold({
			runId: value.id,
			reasonCode: 'integration_hold_released',
			referenceId: 'TEST-CASE-10',
			actorType: 'user',
			actorUserId: contextA.actorUserId,
			policyVersion: 'integration-v1'
		})).released, true);
		assert.equal((await retentionA.previewRuns({ retentionDays: 30 })).candidateCount, 0,
			'a hold release starts a new conservative grace period');

		const expiredRunId = await createExpiredPostHoldFixture(tenantAPool, contextA);
		assert.equal((await retentionB.previewRuns({ retentionDays: 30 })).candidateCount, 0);
		assert.equal((await retentionA.previewRuns({ retentionDays: 30 })).candidateCount, 1);
		const purged = await retentionA.purgeBatch({
			execute: true,
			acknowledgement: PURGE_ACKNOWLEDGEMENT,
			idempotencyKey: 'integration.phase-10.purge-001',
			retentionDays: 30,
			actorType: 'worker',
			reasonCode: 'integration_retention_expired',
			referenceId: 'TEST-CASE-10',
			policyVersion: 'qase-data-lifecycle/v1'
		});
		assert.equal(purged.purgedCount, 1);
		assert.deepEqual(purged.runIds, [expiredRunId]);
		assert.equal((await retentionA.previewRuns({ retentionDays: 30 })).candidateCount, 0);
		await assert.rejects(
			tenantARepository.create({ ...runAggregate(), id: expiredRunId }, {
				eventType: 'session', payload: { title: 'suppressed restore attempt' }
			}),
			/erasure tombstone|suppressed/i,
			'a purged run identifier must not be re-created from a restored backup or import'
		);

		// The dedicated test URL must use the same non-bypass role production uses;
		// a PostgreSQL superuser would make an RLS assertion meaningless.
		const role = await tenantAPool.query(`
			SELECT rolsuper, rolbypassrls
			FROM pg_roles
			WHERE rolname = current_user
		`);
		assert.equal(role.rows[0]?.rolsuper, false, 'QASE_TEST_DATABASE_URL must not use a superuser role');
		assert.equal(role.rows[0]?.rolbypassrls, false, 'QASE_TEST_DATABASE_URL role must not have BYPASSRLS');

		const raw = await tenantAPool.query('SELECT COUNT(*)::int AS count FROM qa_runs');
		assert.equal(raw.rows[0].count, 0, 'forced RLS must default-deny without transaction-local tenant context');
		assert.equal((await tenantAPool.query('SELECT COUNT(*)::int AS count FROM users')).rows[0].count,0,'bootstrap actor visibility must not leak after its transaction ends');
		const rawJobs = await tenantAPool.query('SELECT COUNT(*)::int AS count FROM qa_execution_jobs');
		assert.equal(rawJobs.rows[0].count, 0, 'execution jobs must default-deny without tenant context');
		const rawLifecycle = await tenantAPool.query('SELECT COUNT(*)::int AS count FROM qase_lifecycle_events');
		assert.equal(rawLifecycle.rows[0].count, 0, 'lifecycle audit must default-deny without tenant context');
	}
);
