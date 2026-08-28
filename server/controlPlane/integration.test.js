import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { runControlPlaneMigrations } from './migrations.js';
import { createControlPlaneRepository } from './repository.js';

const { Pool } = pg;
const DATABASE_URL = String(process.env.QASE_TEST_CONTROL_DATABASE_URL ?? '').trim();
const SCHEMA_PATTERN = /^qase_cp_it_[0-9a-f]{24}$/;
const CELL = '1ce430b8-513b-4a30-a01d-b1da61549c18';
const ORG = '8c135239-cc6d-4e29-9f31-d40755137811';
const PROJECT = '63e57ec3-5a83-4491-9706-2ce61763f7d1';

test('real control PostgreSQL registers, places, resolves, audits, and disables without run tables',
	{ skip: !DATABASE_URL }, async t => {
		const schema = `qase_cp_it_${randomBytes(12).toString('hex')}`;
		assert.match(schema, SCHEMA_PATTERN);
		const identifier = `"${schema}"`;
		const admin = new Pool({ connectionString: DATABASE_URL, max: 1 });
		let scoped;
		let repository;
		t.after(async () => {
			if (repository) await repository.close().catch(() => undefined);
			else if (scoped) await scoped.end().catch(() => undefined);
			try { await admin.query(`DROP SCHEMA IF EXISTS ${identifier} CASCADE`); }
			finally { await admin.end().catch(() => undefined); }
		});
		await admin.query(`CREATE SCHEMA ${identifier}`);
		scoped = new Pool({
			connectionString: DATABASE_URL, max: 2,
			options: `-c search_path=${schema},public`, application_name: 'qase-control-integration'
		});
		await runControlPlaneMigrations(scoped);
		repository = createControlPlaneRepository({ pool: scoped, staleAfterSeconds: 90 });
		await repository.upsertCell({
			id: CELL, name: 'Integration cell', region: 'eu-west-1',
			baseUrl: 'https://qase-integration.example.com', capacityWeight: 100,
			organizationId: ORG, projectId: PROJECT
		}, { requestId: 'fb139801-54e8-4289-ad10-f70c92967967' });
		const placed = await repository.place({ organizationId: ORG, projectId: PROJECT, preferredRegion: 'eu-west-1' });
		assert.equal(placed.cell.id, CELL);
		assert.equal((await repository.resolve(ORG, PROJECT)).baseUrl, 'https://qase-integration.example.com');
		const audit = await scoped.query('SELECT event_type FROM qase_control_events ORDER BY id');
		assert.deepEqual(audit.rows.map(row => row.event_type), ['cell.upserted', 'placement.upserted']);
		assert.equal((await scoped.query("SELECT to_regclass('qa_runs') AS name")).rows[0].name, null);
		assert.equal(await repository.disablePlacement(ORG, PROJECT), true);
		assert.equal(await repository.resolve(ORG, PROJECT), undefined);
	});
