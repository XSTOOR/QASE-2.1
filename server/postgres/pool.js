import pg from 'pg';

const { Pool } = pg;

function integerSetting(value, fallback, minimum, maximum, name) {
	if (value === undefined || value === '') return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
	}
	return parsed;
}

function sslSetting(environment) {
	const fallback = environment.NODE_ENV === 'production' ? 'require' : 'disable';
	const mode = String(environment.QASE_DATABASE_SSL ?? fallback).trim().toLowerCase();
	if (mode === 'disable') return false;
	if (mode === 'require') return { rejectUnauthorized: true };
	if (mode === 'no-verify') return { rejectUnauthorized: false };
	throw new TypeError('QASE_DATABASE_SSL must be disable, require, or no-verify.');
}

/** Creates a bounded PostgreSQL pool without ever logging its connection URL. */
export function createPostgresPool(options = {}) {
	const environment = options.environment ?? process.env;
	const PoolClass = options.PoolClass ?? Pool;
	const connectionString = String(
		environment.QASE_DATABASE_URL ?? environment.DATABASE_URL ?? ''
	).trim();
	if (!connectionString) {
		throw new Error('PostgreSQL storage requires QASE_DATABASE_URL or DATABASE_URL.');
	}
	const maximum = integerSetting(environment.QASE_DATABASE_POOL_MAX, 20, 1, 200, 'QASE_DATABASE_POOL_MAX');
	const minimum = integerSetting(environment.QASE_DATABASE_POOL_MIN, 0, 0, 20, 'QASE_DATABASE_POOL_MIN');
	if (minimum > maximum) {
		throw new TypeError('QASE_DATABASE_POOL_MIN cannot exceed QASE_DATABASE_POOL_MAX.');
	}

	const pool = new PoolClass({
		connectionString,
		ssl: sslSetting(environment),
		max: maximum,
		min: minimum,
		connectionTimeoutMillis: integerSetting(
			environment.QASE_DATABASE_CONNECT_TIMEOUT_MS, 10_000, 1_000, 120_000,
			'QASE_DATABASE_CONNECT_TIMEOUT_MS'
		),
		idleTimeoutMillis: integerSetting(
			environment.QASE_DATABASE_IDLE_TIMEOUT_MS, 30_000, 1_000, 600_000,
			'QASE_DATABASE_IDLE_TIMEOUT_MS'
		),
		application_name: 'qase-api'
	});

	pool.on?.('error', () => {
		// Readiness reports failure without exposing hostnames, usernames or URLs.
	});
	return pool;
}
