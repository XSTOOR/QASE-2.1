import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresPool } from './pool.js';

class FakePool {
	constructor(options) { this.options = options; }
	on() {}
}

test('PostgreSQL pool uses a bounded validated process identity without exposing its URL', () => {
	const pool = createPostgresPool({
		environment: { QASE_DATABASE_URL: 'postgresql://user:password@db.invalid/qase', QASE_DATABASE_SSL: 'disable' },
		applicationName: 'qase-control-plane',
		PoolClass: FakePool
	});
	assert.equal(pool.options.application_name, 'qase-control-plane');
	assert.equal(pool.options.max, 20);
	assert.throws(() => createPostgresPool({
		environment: { QASE_DATABASE_URL: 'postgresql://db.invalid/qase' },
		applicationName: 'unsafe name', PoolClass: FakePool
	}), /application name/);
});
