const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UNTRUSTED_CONTEXT_KEYS = Object.freeze([
	'body', 'headers', 'params', 'query', 'request', 'tenant', 'tenantId'
]);
const UNTRUSTED_FACTORY_KEYS = Object.freeze([
	'organizationId', 'organization_id', 'projectId', 'project_id', 'tenant', 'tenantId'
]);
const MAX_NONCE_LIFETIME_MS = 60 * 60 * 1000;

function canonicalUuid(value, label) {
	if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
		throw new TypeError(`${label} must be a canonical UUID.`);
	}
	return value.toLowerCase();
}

function trustedTenantContext(value) {
	if (!value || typeof value !== 'object' || !Object.isFrozen(value)) {
		throw new TypeError('Drytis nonce storage requires a frozen trusted tenant context.');
	}
	for (const key of UNTRUSTED_CONTEXT_KEYS) {
		if (Object.hasOwn(value, key)) {
			throw new TypeError('Drytis nonce storage rejects request-supplied tenant context.');
		}
	}
	return Object.freeze({
		organizationId: canonicalUuid(value.organizationId, 'organizationId'),
		projectId: canonicalUuid(value.projectId, 'projectId')
	});
}

function nonceDigest(value) {
	if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
		throw new TypeError('nonceSha256 must be a lowercase SHA-256 digest.');
	}
	return value;
}

function currentTime(now) {
	const result = Number(now());
	if (!Number.isSafeInteger(result) || result < 0) {
		throw new TypeError('The Drytis nonce store clock is invalid.');
	}
	return result;
}

function expiration(value, currentMs) {
	if (!Number.isSafeInteger(value) || value <= currentMs
		|| value > currentMs + MAX_NONCE_LIFETIME_MS) {
		throw new TypeError('expiresAtMs must be a future timestamp no more than one hour away.');
	}
	return new Date(value);
}

async function setTenantScope(client, tenant) {
	await client.query(
		"SELECT set_config('qase.organization_id', $1, true), set_config('qase.project_id', $2, true)",
		[tenant.organizationId, tenant.projectId]
	);
}

/**
 * Durable, atomic replay protection for signed Drytis -> Qase requests.
 *
 * Only a digest of the transport nonce is retained. PostgreSQL uniqueness and
 * the transaction boundary make concurrent reservations safe across replicas.
 */
export function createPostgresDrytisNonceStore(options = {}) {
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new TypeError('Drytis nonce storage options are required.');
	}
	for (const key of UNTRUSTED_FACTORY_KEYS) {
		if (Object.hasOwn(options, key)) {
			throw new TypeError('Drytis nonce storage rejects request-supplied tenant selectors.');
		}
	}
	const { pool, tenantContext, now = Date.now } = options;
	if (!pool || typeof pool.connect !== 'function') {
		throw new TypeError('A PostgreSQL pool is required.');
	}
	if (typeof now !== 'function') throw new TypeError('now must be a function.');
	const tenant = trustedTenantContext(tenantContext);

	return Object.freeze({
		async consume(nonceSha256, expiresAtMs) {
			const digest = nonceDigest(nonceSha256);
			const expiresAt = expiration(expiresAtMs, currentTime(now));
			const client = await pool.connect();
			try {
				await client.query('BEGIN');
				await setTenantScope(client, tenant);
				await client.query(
					`WITH expired AS (
						SELECT ctid FROM qase_drytis_request_nonces
						 WHERE organization_id = $1 AND project_id = $2
						 AND expires_at <= CURRENT_TIMESTAMP
						 ORDER BY expires_at, nonce_sha256
						 LIMIT 1000 FOR UPDATE SKIP LOCKED
					)
					DELETE FROM qase_drytis_request_nonces nonce USING expired
					 WHERE nonce.ctid = expired.ctid`,
					[tenant.organizationId, tenant.projectId]
				);
				const result = await client.query(
					`INSERT INTO qase_drytis_request_nonces
					 (organization_id, project_id, nonce_sha256, expires_at)
					 VALUES ($1, $2, $3, $4)
					 ON CONFLICT DO NOTHING RETURNING nonce_sha256`,
					[tenant.organizationId, tenant.projectId, digest, expiresAt]
				);
				await client.query('COMMIT');
				return result.rows?.length === 1;
			} catch (error) {
				await client.query('ROLLBACK').catch(() => undefined);
				throw error;
			} finally {
				client.release();
			}
		}
	});
}

