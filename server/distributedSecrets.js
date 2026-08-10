import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createClient } from 'redis';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function masterKey(value) {
	if (typeof value !== 'string' || value.trim() === '') throw new Error('Distributed execution requires QASE_SECRETS_MASTER_KEY.');
	let key;
	try { key = Buffer.from(value.trim(), 'base64url'); } catch { key = undefined; }
	if (!key || key.length !== 32) throw new TypeError('QASE_SECRETS_MASTER_KEY must be a base64url-encoded 32-byte key.');
	return key;
}
function normalizedEntries(entries) {
	if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return {};
	const result = {};
	for (const [rawName, value] of Object.entries(entries).slice(0, 50)) {
		if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) continue;
		const name = rawName.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 100);
		if (name) result[name] = value;
	}
	if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 131_072) throw new TypeError('Credential payload is too large.');
	return result;
}

export function createDistributedSecrets(options = {}) {
	const environment = options.environment ?? process.env;
	const tenant = options.tenantContext;
	if (!tenant || !UUID_PATTERN.test(tenant.organizationId) || !UUID_PATTERN.test(tenant.projectId)) {
		throw new TypeError('Distributed secrets require trusted tenant UUIDs.');
	}
	const keyMaterial = options.key ? Buffer.from(options.key) : masterKey(environment.QASE_SECRETS_MASTER_KEY);
	if (keyMaterial.length !== 32) throw new TypeError('Distributed secrets require a 32-byte encryption key.');
	const ttlSeconds = Math.max(300, Math.min(86_400, Number(options.ttlSeconds ?? environment.QASE_SECRETS_TTL_SECONDS) || 3_600));
	const redisUrl = String(options.url ?? environment.QASE_REDIS_URL ?? '').trim();
	if (!redisUrl) throw new Error('Distributed secrets require QASE_REDIS_URL.');
	const parsedRedisUrl = new URL(redisUrl);
	if (!['redis:', 'rediss:'].includes(parsedRedisUrl.protocol)) throw new TypeError('QASE_REDIS_URL must use redis:// or rediss://.');
	if (environment.NODE_ENV === 'production' && parsedRedisUrl.protocol !== 'rediss:' && !options.allowInsecure) {
		throw new Error('Production distributed secrets require a TLS rediss:// URL.');
	}
	const client = options.client ?? (options.createClient ?? createClient)({ url: redisUrl });
	let loaded = false;
	let closePromise;
	function redisKey(runId) {
		if (!UUID_PATTERN.test(runId)) throw new TypeError('runId must be a canonical UUID.');
		return `qase:v1:${tenant.organizationId}:${tenant.projectId}:secrets:${runId}`;
	}
	function encrypt(value, aad) {
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', keyMaterial, iv);
		cipher.setAAD(Buffer.from(aad));
		const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
		return JSON.stringify({ v: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: ciphertext.toString('base64url') });
	}
	function decrypt(value, aad) {
		const envelope = JSON.parse(value);
		if (envelope?.v !== 1) throw new Error('Unsupported distributed credential envelope.');
		const decipher = createDecipheriv('aes-256-gcm', keyMaterial, Buffer.from(envelope.iv, 'base64url'));
		decipher.setAAD(Buffer.from(aad));
		decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
		return JSON.parse(Buffer.concat([
			decipher.update(Buffer.from(envelope.data, 'base64url')), decipher.final()
		]).toString('utf8'));
	}
	async function loadValues(runId) {
		const name = redisKey(runId);
		const stored = await client.get(name);
		return stored ? normalizedEntries(decrypt(stored, name)) : {};
	}
	return Object.freeze({
		async load() { if (!loaded) { await client.connect(); loaded = true; } },
		async store(runId, entries) {
			const name = redisKey(runId);
			const values = { ...(await loadValues(runId)), ...normalizedEntries(entries) };
			if (Object.keys(values).length === 0) return [];
			await client.set(name, encrypt(values, name), { EX: ttlSeconds });
			return Object.keys(values);
		},
		async values(runId) { return loadValues(runId); },
		async names(runId) { return Object.keys(await loadValues(runId)); },
		async clear(runId) { await client.del(redisKey(runId)); },
		async check() { return loaded && await client.ping() === 'PONG'; },
		close() {
			closePromise ??= (async () => { if (loaded) await client.close(); })();
			return closePromise;
		}
	});
}
