import assert from 'node:assert/strict';
import test from 'node:test';
import { loadMigrations } from '../postgres/migrations.js';
import { CONTROL_MIGRATIONS_DIRECTORY } from './migrations.js';

test('control plane has an isolated, ordered migration set without run-domain tables', async () => {
	const migrations = await loadMigrations(CONTROL_MIGRATIONS_DIRECTORY);
	assert.deepEqual(migrations.map(item => [item.version, item.name]), [
		[1, 'cell_registry'],
		[2, 'tenant_bound_cells']
	]);
	assert.match(migrations[0].sql, /CREATE TABLE qase_cells/);
	assert.match(migrations[0].sql, /CREATE TABLE qase_project_placements/);
	assert.match(migrations[0].sql, /CREATE TABLE qase_control_events/);
	assert.doesNotMatch(migrations[0].sql, /qa_runs|qa_messages|credential|finding/);
	assert.match(migrations[1].sql, /bound_organization_id uuid/);
	assert.match(migrations[1].sql, /bound_project_id uuid/);
	assert.match(migrations[1].sql, /qase_cells_tenant_placement_candidates/);
	assert.doesNotMatch(migrations[1].sql, /UNIQUE INDEX[\s\S]*bound_organization_id[\s\S]*bound_project_id/i);
});
