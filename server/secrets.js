import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Session-scoped credential vault.
 *
 * Values are encrypted per run so an ordinary process restart can continue an
 * authenticated assessment without asking the operator for the same password
 * again. The model still sees placeholder names only. The browser bridge swaps
 * placeholders for real values at the keyboard boundary, and the redactor
 * scrubs any value that leaks back through a tool result or page snapshot.
 */

const MASK = '••••••••';
const PLACEHOLDER = /\{\{\s*([A-Z0-9_]+)\s*\}\}/g;

const DEFAULT_STATE_DIRECTORY = path.join(process.cwd(), '.qase');
const ENVELOPE_VERSION = 1;

function normalizedEntries(entries) {
	const result = new Map();
	for (const [name, value] of Object.entries(entries ?? {}).slice(0, 50)) {
		if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) continue;
		const key = name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 100);
		if (key) result.set(key, value);
	}
	return result;
}

/** Builds a synchronous local vault whose encrypted records survive restarts. */
export function createLocalSecretVault(options = {}) {
	const stateDirectory = options.stateDirectory ?? DEFAULT_STATE_DIRECTORY;
	const recordsDirectory = path.join(stateDirectory, 'run-secrets');
	const keyFile = options.keyFile ?? path.join(stateDirectory, 'run-secrets.key');
	const vaults = new Map();
	let keyMaterial = options.key ? Buffer.from(options.key) : undefined;

	function assertSessionId(sessionId) {
		if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 200) {
			throw new TypeError('sessionId is required.');
		}
		return sessionId;
	}

	function recordPath(sessionId) {
		const digest = createHash('sha256').update(assertSessionId(sessionId)).digest('hex');
		return path.join(recordsDirectory, `${digest}.json`);
	}

	function encryptionKey() {
		if (keyMaterial) {
			if (keyMaterial.length !== 32) throw new TypeError('Local credential vault key must be 32 bytes.');
			return keyMaterial;
		}
		fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
		try {
			keyMaterial = fs.readFileSync(keyFile);
		} catch (error) {
			if (error?.code !== 'ENOENT') throw error;
			const generated = randomBytes(32);
			try {
				fs.writeFileSync(keyFile, generated, { flag: 'wx', mode: 0o600 });
				keyMaterial = generated;
			} catch (writeError) {
				if (writeError?.code !== 'EEXIST') throw writeError;
				keyMaterial = fs.readFileSync(keyFile);
			}
		}
		if (keyMaterial.length !== 32) throw new Error('Local credential vault key is invalid.');
		return keyMaterial;
	}

	function aad(sessionId) {
		return Buffer.from(`qase-local-run-secrets:v${ENVELOPE_VERSION}:${sessionId}`);
	}

	function encrypt(sessionId, entries) {
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
		cipher.setAAD(aad(sessionId));
		const plaintext = JSON.stringify(Object.fromEntries(entries));
		const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
		return JSON.stringify({
			v: ENVELOPE_VERSION,
			iv: iv.toString('base64url'),
			tag: cipher.getAuthTag().toString('base64url'),
			data: data.toString('base64url')
		});
	}

	function decrypt(sessionId, serialized) {
		const envelope = JSON.parse(serialized);
		if (envelope?.v !== ENVELOPE_VERSION || !envelope.iv || !envelope.tag || !envelope.data) {
			throw new Error('Unsupported local credential envelope.');
		}
		const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(envelope.iv, 'base64url'));
		decipher.setAAD(aad(sessionId));
		decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
		const value = JSON.parse(Buffer.concat([
			decipher.update(Buffer.from(envelope.data, 'base64url')),
			decipher.final()
		]).toString('utf8'));
		return normalizedEntries(value);
	}

	function load(sessionId) {
		assertSessionId(sessionId);
		if (vaults.has(sessionId)) return vaults.get(sessionId);
		let vault = new Map();
		try {
			vault = decrypt(sessionId, fs.readFileSync(recordPath(sessionId), 'utf8'));
		} catch {
			// Missing, corrupt, or undecryptable records never advertise names or
			// resolve placeholders. Keep the record for forensic recovery.
		}
		vaults.set(sessionId, vault);
		return vault;
	}

	function persist(sessionId, vault) {
		fs.mkdirSync(recordsDirectory, { recursive: true, mode: 0o700 });
		const file = recordPath(sessionId);
		const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
		try {
			fs.writeFileSync(temporary, encrypt(sessionId, vault), { mode: 0o600 });
			fs.renameSync(temporary, file);
		} catch (error) {
			try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
			throw error;
		}
	}

	function vaultFor(sessionId) {
		return load(sessionId);
	}

	function store(sessionId, entries) {
		const vault = vaultFor(sessionId);
		const supplied = normalizedEntries(entries);
		for (const [name, value] of supplied) vault.set(name, value);
		if (supplied.size > 0) persist(sessionId, vault);
		return [...supplied.keys()];
	}

	function clear(sessionId) {
		const file = recordPath(sessionId);
		const existed = vaults.delete(sessionId) || fs.existsSync(file);
		fs.rmSync(file, { force: true });
		return existed;
	}

	function names(sessionId) {
		return [...vaultFor(sessionId).keys()];
	}

	function resolve(sessionId, text) {
		if (typeof text !== 'string' || !text.includes('{{')) return text;
		const vault = vaultFor(sessionId);
		return text.replace(PLACEHOLDER, (match, name) => vault.get(name) ?? match);
	}

	function hasUnresolved(sessionId, text) {
		if (typeof text !== 'string') return false;
		const vault = vaultFor(sessionId);
		return [...text.matchAll(PLACEHOLDER)].some(match => !vault.has(match[1]));
	}

	function redactValue(sessionId, value) {
		const secrets = [...vaultFor(sessionId).values()].filter(secret => secret.length >= 3);
		if (secrets.length === 0) return value;
		const scrubString = text => secrets.reduce(
			(output, secret) => output.includes(secret) ? output.split(secret).join(MASK) : output,
			text
		);
		const walk = (input, depth) => {
			if (depth > 8) return input;
			if (typeof input === 'string') return scrubString(input);
			if (Array.isArray(input)) return input.map(item => walk(item, depth + 1));
			if (input && typeof input === 'object') {
				return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, walk(item, depth + 1)]));
			}
			return input;
		};
		return walk(value, 0);
	}

	return Object.freeze({ clear, hasUnresolved, names, redact: redactValue, resolve, store });
}

const localVault = createLocalSecretVault();

export function vaultFor(sessionId) {
	return new Map(localVault.names(sessionId).map(name => [name, localVault.resolve(sessionId, `{{${name}}}`)]));
}

export function storeSecrets(sessionId, entries) {
	return localVault.store(sessionId, entries);
}

export function clearSecrets(sessionId) {
	return localVault.clear(sessionId);
}

export function secretNames(sessionId) {
	return localVault.names(sessionId);
}

/** Substitutes `{{NAME}}` placeholders with their stored values. */
export function resolveSecrets(sessionId, text) {
	return localVault.resolve(sessionId, text);
}

/** True when the text still holds an unresolved placeholder. */
export function hasUnresolvedPlaceholder(sessionId, text) {
	return localVault.hasUnresolved(sessionId, text);
}

/**
 * Deep-copies a value with every stored secret replaced by a mask. Applied to
 * everything that reaches the model or the dashboard, so a secret that ends up
 * in a page snapshot or an error message does not travel any further.
 */
export function redact(sessionId, value) {
	return localVault.redact(sessionId, value);
}
