import * as fs from 'node:fs';
import { lookup as lookupDns } from 'node:dns/promises';
import { isIP } from 'node:net';
import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

const userConfiguration = new AsyncLocalStorage();
export function withUserConfiguration(settings, save, work) {
	return userConfiguration.run({ settings, save }, work);
}

/**
 * Model settings, resolved from the settings file first and the environment
 * second, so the dashboard can point Qase at a custom endpoint without anyone
 * editing .env and restarting.
 *
 * The `custom` provider is an OpenAI-compatible endpoint: the three things it
 * needs are a key, a base URL and a model name.
 */

const CONFIG_DIR = path.join(process.cwd(), '.qase');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export const PROVIDERS = [
	'custom', 'anthropic', 'openai', 'azureOpenAI', 'gemini',
	'grok', 'nvidia', 'openrouter', 'bedrock'
];

/** Providers that will not start without a base URL of their own. */
const NEEDS_BASE_URL = new Set(['custom', 'azureOpenAI']);
const DEFAULT_PROBE_TIMEOUT_MS = 12_000;
const DEFAULT_PROBE_MAX_BYTES = 1024 * 1024;
const RESERVED_HOST_SUFFIXES = [
	'localhost', '.localhost', '.local', '.internal', '.home.arpa',
	'.example', '.invalid', '.test'
];

let stored;

function readStored() {
	if (userConfiguration.getStore()) return userConfiguration.getStore().settings;
	if (stored) {
		return stored;
	}
	try {
		stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
	} catch {
		stored = {};
	}
	return stored;
}

function fromEnv() {
	return {
		provider: process.env.QASE_PROVIDER,
		apiKey: process.env.QASE_API_KEY ?? process.env.ANTHROPIC_API_KEY,
		baseUrl: process.env.QASE_BASE_URL,
		model: process.env.QASE_MODEL,
		reasoning: process.env.QASE_REASONING,
		maxTurns: process.env.QASE_MAX_TURNS ? Number(process.env.QASE_MAX_TURNS) : undefined,
		headless: process.env.QASE_HEADLESS === undefined ? undefined : process.env.QASE_HEADLESS !== 'false'
	};
}

const DEFAULTS = {
	provider: 'anthropic',
	apiKey: '',
	baseUrl: '',
	model: 'claude-opus-5',
	reasoning: 'medium',
	maxTurns: 120,
	headless: true
};

/** The effective settings the agent runs with. Includes the key — server only. */
export function getConfig() {
	const merged = { ...DEFAULTS };
	for (const source of [userConfiguration.getStore() ? {} : fromEnv(), readStored()]) {
		for (const [key, value] of Object.entries(source)) {
			if (value !== undefined && value !== null && value !== '') {
				merged[key] = value;
			}
		}
	}
	return merged;
}

/** The same settings with the key reduced to a hint. Safe to send to a browser. */
export function getPublicConfig() {
	const config = getConfig();
	return {
		provider: config.provider,
		baseUrl: config.baseUrl,
		model: config.model,
		reasoning: config.reasoning,
		maxTurns: config.maxTurns,
		headless: config.headless,
		hasApiKey: Boolean(config.apiKey),
		apiKeyHint: config.apiKey ? `••••${config.apiKey.slice(-4)}` : '',
		apiKeyFromEnv: !userConfiguration.getStore() && Boolean(fromEnv().apiKey) && !readStored().apiKey,
		providers: PROVIDERS,
		ready: isReady(config),
		problem: describeProblem(config)
	};
}

function isReady(config = getConfig()) {
	return !describeProblem(config);
}

function describeProblem(config) {
	if (config.provider !== 'bedrock' && !config.apiKey) {
		return 'No API key set.';
	}
	if (NEEDS_BASE_URL.has(config.provider) && !config.baseUrl) {
		return 'This provider needs a base URL.';
	}
	if (!config.model) {
		return 'No model name set.';
	}
	return undefined;
}

export function saveConfig(patch) {
	const next = { ...readStored() };
	for (const key of ['provider', 'apiKey', 'baseUrl', 'model', 'reasoning']) {
		if (typeof patch[key] === 'string') {
			next[key] = patch[key].trim();
		}
	}
	if (patch.maxTurns !== undefined) {
		next.maxTurns = Math.max(10, Math.min(500, Number(patch.maxTurns) || DEFAULTS.maxTurns));
	}
	if (patch.headless !== undefined) {
		next.headless = Boolean(patch.headless);
	}
	if (next.provider && !PROVIDERS.includes(next.provider)) {
		throw new Error(`Unknown provider: ${next.provider}`);
	}
	if (userConfiguration.getStore() && next.provider === 'bedrock') {
		throw new Error('Private workspaces require an explicit API key provider. Shared AWS credentials are not supported.');
	}

	const scope = userConfiguration.getStore();
	if (scope) return scope.save(next).then(() => {
		scope.settings = next;
		return getPublicConfig();
	});
	stored = next;
	fs.mkdirSync(CONFIG_DIR, { recursive: true });
	fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, undefined, '\t'), { mode: 0o600 });
	return getPublicConfig();
}

function ipv4Octets(address) {
	const parts = address.split('.');
	if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return undefined;
	const octets = parts.map(Number);
	return octets.every(part => part >= 0 && part <= 255) ? octets : undefined;
}

function isBlockedIpv4(address) {
	const octets = ipv4Octets(address);
	if (!octets) return true;
	const [a, b, c] = octets;
	return a === 0
		|| a === 10
		|| a === 127
		|| (a === 100 && b >= 64 && b <= 127)
		|| (a === 169 && b === 254)
		|| (a === 172 && b >= 16 && b <= 31)
		|| (a === 192 && b === 0 && (c === 0 || c === 2))
		|| (a === 192 && b === 31 && c === 196)
		|| (a === 192 && b === 52 && c === 193)
		|| (a === 192 && b === 88 && c === 99)
		|| (a === 192 && b === 175 && c === 48)
		|| (a === 192 && b === 168)
		|| (a === 198 && (b === 18 || b === 19))
		|| (a === 198 && b === 51 && c === 100)
		|| (a === 203 && b === 0 && c === 113)
		|| a >= 224;
}

function ipv6Bytes(address) {
	let input = address.toLowerCase().replace(/^\[|\]$/g, '');
	if (input.includes('%')) return undefined;
	const ipv4Match = input.match(/((?:\d{1,3}\.){3}\d{1,3})$/);
	if (ipv4Match) {
		const octets = ipv4Octets(ipv4Match[1]);
		if (!octets) return undefined;
		input = `${input.slice(0, ipv4Match.index)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
	}
	if ((input.match(/::/g) ?? []).length > 1) return undefined;
	const [leftText, rightText] = input.split('::');
	const left = leftText ? leftText.split(':') : [];
	const right = rightText ? rightText.split(':') : [];
	if ([...left, ...right].some(part => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
	const missing = 8 - left.length - right.length;
	if (missing < 0 || (!input.includes('::') && missing !== 0)) return undefined;
	const words = [...left, ...Array(missing).fill('0'), ...right].map(part => Number.parseInt(part, 16));
	if (words.length !== 8) return undefined;
	return words.flatMap(word => [word >>> 8, word & 0xff]);
}

function isBlockedIpv6(address) {
	const bytes = ipv6Bytes(address);
	if (!bytes) return true;
	const allZero = bytes.every(byte => byte === 0);
	const loopback = bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1;
	if (allZero || loopback) return true;
	// IPv4-mapped IPv6 must be evaluated using the embedded IPv4 address.
	if (bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
		return isBlockedIpv4(bytes.slice(12).join('.'));
	}
	if (bytes.slice(0, 12).every(byte => byte === 0)) return true;
	const uniqueLocal = (bytes[0] & 0xfe) === 0xfc;
	const linkLocal = bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80;
	const multicast = bytes[0] === 0xff;
	const documentation = bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8;
	const specialProtocol = bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] <= 0x01;
	const sixToFour = bytes[0] === 0x20 && bytes[1] === 0x02;
	const wellKnownNat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff
		&& bytes[3] === 0x9b && bytes.slice(4, 12).every(byte => byte === 0);
	const localNat64 = bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff
		&& bytes[3] === 0x9b && bytes[4] === 0x00 && bytes[5] === 0x01;
	return uniqueLocal || linkLocal || multicast || documentation || specialProtocol || sixToFour
		|| wellKnownNat64 || localNat64;
}

function isBlockedAddress(address) {
	const version = isIP(address.replace(/^\[|\]$/g, ''));
	if (version === 4) return isBlockedIpv4(address);
	if (version === 6) return isBlockedIpv6(address);
	return true;
}

function parseProbeUrl(baseUrl, { production }) {
	const raw = String(baseUrl ?? '').trim();
	if (!raw || raw.length > 2048) throw new Error('The model endpoint URL is invalid.');
	let base;
	try { base = new URL(raw); } catch { throw new Error('The model endpoint URL is invalid.'); }
	if (!['http:', 'https:'].includes(base.protocol)) throw new Error('The model endpoint must use HTTP or HTTPS.');
	if (production && base.protocol !== 'https:') throw new Error('The model endpoint must use HTTPS in production.');
	if (base.username || base.password) throw new Error('The model endpoint URL must not contain credentials.');
	if (base.search || base.hash) throw new Error('The model endpoint URL must not contain a query string or fragment.');
	base.pathname = `${base.pathname.replace(/\/+$/, '')}/models`;
	return base;
}

async function assertSafeDestination(url, { dnsLookup, allowPrivateNetwork }) {
	const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
	if (!allowPrivateNetwork && RESERVED_HOST_SUFFIXES.some(suffix => hostname === suffix || hostname.endsWith(suffix))) {
		throw new Error('The model endpoint must use a public network destination.');
	}
	const directVersion = isIP(hostname);
	const records = directVersion
		? [{ address: hostname, family: directVersion }]
		: await dnsLookup(hostname, { all: true, verbatim: true });
	const addresses = Array.isArray(records) ? records : [records];
	if (addresses.length === 0 || addresses.some(record => !record?.address)) {
		throw new Error('The model endpoint hostname did not resolve.');
	}
	if (!allowPrivateNetwork && addresses.some(record => isBlockedAddress(String(record.address)))) {
		throw new Error('The model endpoint must use a public network destination.');
	}
}

function isJsonContentType(value) {
	const type = String(value ?? '').split(';', 1)[0].trim().toLowerCase();
	return type === 'application/json' || type.endsWith('+json');
}

async function readBoundedJson(response, maxBytes) {
	const declaredLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		throw new Error('The model endpoint response was too large.');
	}
	if (!isJsonContentType(response.headers.get('content-type'))) {
		throw new Error('The model endpoint did not return JSON.');
	}
	if (!response.body?.getReader) throw new Error('The model endpoint returned an unreadable response.');
	const reader = response.body.getReader();
	const chunks = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > maxBytes) {
				await reader.cancel();
				throw new Error('The model endpoint response was too large.');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	try { return JSON.parse(new TextDecoder().decode(bytes)); }
	catch { throw new Error('The model endpoint returned invalid JSON.'); }
}

function connectionFailureMessage(error) {
	// Fetch hides transport failures behind "fetch failed". Never expose nested
	// messages, which may contain sensitive request details.
	const pending = [error];
	const codes = new Set();
	for (let index = 0; index < pending.length && index < 16; index++) {
		const item = pending[index];
		if (!item || typeof item !== 'object') continue;
		codes.add(item.code);
		if (item.cause) pending.push(item.cause);
		if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 16));
	}
	if (codes.has('EACCES') || codes.has('EPERM')) {
		return 'Outbound network access is denied (EACCES/EPERM). Run the Qase server with permission to reach the model gateway; check sandbox or firewall restrictions.';
	}
	if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')) {
		return 'The gateway hostname could not be resolved. Check the base URL and server DNS connectivity.';
	}
	if (codes.has('ECONNREFUSED')) {
		return 'The gateway refused the connection. Check its address, port and service availability.';
	}
	if (error?.name === 'TimeoutError' || codes.has('ETIMEDOUT') || codes.has('UND_ERR_CONNECT_TIMEOUT')) {
		return 'The gateway connection timed out. Check server network access and gateway availability.';
	}
	return error instanceof Error ? error.message : 'Request failed.';
}

/**
 * Probes an OpenAI-compatible endpoint's model list. It is a reachability and
 * credential check, not a guarantee — some gateways do not implement /models,
 * so a failure here is reported as a warning rather than a hard error.
 */
export async function testConnection(candidate, options = {}) {
	const config = { ...getConfig(), ...candidate };
	const problem = describeProblem(config);
	if (problem) {
		return { ok: false, error: problem };
	}
	if (!config.baseUrl) {
		return { ok: true, skipped: true, message: `${config.provider} uses its own endpoint; nothing to probe.` };
	}

	const environment = options.environment ?? process.env;
	const production = environment.NODE_ENV === 'production';
	const allowPrivateNetwork = options.allowPrivateNetwork ?? !production;
	const dnsLookup = options.dnsLookup ?? lookupDns;
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = Math.max(1, Math.min(30_000, Number(options.timeoutMs) || DEFAULT_PROBE_TIMEOUT_MS));
	const maxBytes = Math.max(1024, Math.min(5 * 1024 * 1024,
		Number(options.maxResponseBytes) || DEFAULT_PROBE_MAX_BYTES));
	let url;
	try {
		url = parseProbeUrl(config.baseUrl, { production });
		await assertSafeDestination(url, { dnsLookup, allowPrivateNetwork });
		const response = await fetchImpl(url.toString(), {
			headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
			redirect: 'error',
			signal: (options.createTimeoutSignal ?? AbortSignal.timeout)(timeoutMs)
		});
		if (!response.ok) {
			return {
				ok: false,
				error: `${url} returned ${response.status}. ${response.status === 401 ? 'The key was rejected.' : 'Check the base URL.'}`
			};
		}
		const body = await readBoundedJson(response, maxBytes);
		const listed = body && typeof body === 'object' ? (body.data ?? body.models ?? []) : [];
		const models = (Array.isArray(listed) ? listed : [])
			.map(entry => entry?.id ?? entry?.name)
			.filter(value => typeof value === 'string' && value.length > 0 && value.length <= 512);
		return {
			ok: true,
			models: models.slice(0, 200),
			matched: models.length === 0 ? undefined : models.includes(config.model),
			message: models.length > 0
				? `Reachable — ${models.length} model(s) listed.`
				: 'Reachable, but the endpoint listed no models.'
		};
	} catch (error) {
		const target = url?.toString() ?? String(config.baseUrl ?? '').trim();
		return { ok: false, error: `Could not reach ${target}: ${connectionFailureMessage(error)}` };
	}
}
