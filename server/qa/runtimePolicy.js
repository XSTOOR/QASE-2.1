import { createHmac, randomBytes } from 'node:crypto';

// Only operator-configured public paths and diagnostic strings are retained verbatim.
// Unknown page-controlled strings get run-local fingerprints, including console arguments.
export function diagnosticPolicy(session, config = {}) {
	const key = randomBytes(32);
	const fingerprint = value => createHmac('sha256', key).update(String(value)).digest('hex').slice(0, 12);
	const origin = new URL(session.targetUrl).origin;
	const rules = config.contracts ?? [];
	const publicPaths = new Set(['/', ...config.publicPaths ?? []]);
	for (const rule of rules.filter(rule => rule.origin === origin)) {
		for (const path of [rule.page, rule.endpoint, rule.destination, rule.script]) if (path) publicPaths.add(path);
	}
	function url(value) {
		if (!value) return undefined;
		if (value === 'about:blank') return value;
		try {
			const parsed = new URL(value);
			if (!/^https?:$/.test(parsed.protocol)) return '[external scheme]';
			const host = parsed.origin === origin ? origin : 'https://external-' + fingerprint(parsed.origin) + '.invalid';
			const path = parsed.pathname;
			const fragment = parsed.hash.startsWith('#/') ? '#/route-' + fingerprint(parsed.hash.split('?')[0]) : '';
			return host + (publicPaths.has(path) && parsed.origin === origin ? path : '/path-' + fingerprint(path)) + fragment;
		} catch { return '[unavailable URL]'; }
	}
	function message(value) {
		const raw = String(value);
		if (config.publicMessages?.includes(raw)) return raw;
		const standard = ['Cannot read properties of undefined', 'Cannot read properties of null', 'Maximum call stack size exceeded', 'Failed to fetch', 'Failed to load resource', 'Unexpected end of JSON input'].find(prefix => raw.includes(prefix));
		const kind = standard ?? raw.match(/\b(TypeError|SyntaxError|ReferenceError|RangeError|Failed to fetch|Failed to load resource|DeprecationWarning|Error)\b/)?.[1] ?? 'Message';
		return kind + ' [' + fingerprint(raw.slice(0, 8192)) + ']';
	}
	return { origin, url, message };
}

const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

export function readDiagnosticConfig(raw) {
	const config = raw ? JSON.parse(raw) : {};
	if (!config || typeOf(config) !== 'object') throw new Error('Invalid diagnostics configuration');
	for (const prop of ['publicPaths', 'publicMessages', 'contracts']) {
		if (config[prop] !== undefined && (!Array.isArray(config[prop]) || config[prop].length > 100)) throw new Error('Invalid diagnostics list');
	}
	if (config.enabled !== undefined && typeof config.enabled !== 'boolean') throw new Error('Invalid monitoring switch');
	for (const text of [...config.publicPaths ?? [], ...config.publicMessages ?? []]) {
		if (typeof text !== 'string' || text.length > 500) throw new Error('Invalid public evidence allowance');
	}
	const ids = new Set();
	for (const rule of config.contracts ?? []) {
		if (typeof rule?.id !== 'string' || !/^[a-z0-9_-]{1,80}$/i.test(rule.id) || new URL(rule.origin).origin !== rule.origin ||
			!rule.page?.startsWith('/') || !rule.endpoint?.startsWith('/') || !/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(rule.method)) throw new Error('Invalid diagnostic contract');
		if (ids.has(rule.id)) throw new Error('Duplicate contract ID');
		ids.add(rule.id);
		if (rule.values && (typeOf(rule.values) !== 'object' || Object.values(rule.values).some(v => !['number','boolean','string','null'].includes(typeOf(v))))) throw new Error('Expected values must be JSON scalars');
		if (rule.expectedText !== undefined && (!rule.visible || typeof rule.expectedText !== 'string' || rule.expectedText.length > 300)) throw new Error('Invalid visible text expectation');
		if (rule.visible || rule.destination || rule.script) {
			if (!rule.control || !Number.isInteger(rule.timeoutMs) || rule.timeoutMs <= 0 || rule.timeoutMs > 10000) throw new Error('UI expectations require a control and bounded timeout');
		}
		if (rule.statuses && (!Array.isArray(rule.statuses) || !rule.statuses.length || rule.statuses.some(s => !Number.isInteger(s) || s < 100 || s > 599))) throw new Error('Invalid expected status');
		if (rule.fields && (typeOf(rule.fields) !== 'object' || Object.values(rule.fields).some(t => !['array','number','boolean','string','object','null'].includes(t)))) throw new Error('Invalid response field types');
		if (rule.severity && !['low','medium','high','critical'].includes(rule.severity)) throw new Error('Invalid impact severity');
	}
	for (const ms of [...Object.values(config.thresholdsMs ?? {}), ...(config.contracts ?? []).map(r => r.slowMs).filter(v => v !== undefined)]) {
		if (!Number.isFinite(ms) || ms <= 0) throw new Error('Invalid performance threshold');
	}
	if (config.maxEvents !== undefined && (!Number.isInteger(config.maxEvents) || config.maxEvents < 1 || config.maxEvents > 5000)) throw new Error('Invalid history limit');
	return config;
}

// Only inspect an explicitly approved, small, completed same-origin JSON response.
// Refuse compressed or unknown-length bodies before allocating payload memory.
export async function checkResponse(response, rule) {
	if (rule.statuses && !rule.statuses.includes(response.status())) return { violation: 'HTTP status outside the approved set' };
	const headers = response.headers();
	const type = (headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
	if (rule.contentType && type !== rule.contentType) return { violation: 'Unexpected response content type' };
	if (!rule.fields && !rule.values) return {};
	const length = Number(headers['content-length']);
	if (!Number.isInteger(length) || length < 1 || length > 32768 || !/^application\/(?:[\w.-]+\+)?json$/.test(type) ||
		(headers['content-encoding'] && headers['content-encoding'] !== 'identity')) return { gap: 'JSON body unavailable for bounded validation' };
	const sizes = await response.request().sizes();
	if (sizes.responseBodySize !== length) return { gap: 'Body size could not be verified' };
	let data;
	const body = await response.body();
	try { data = JSON.parse(body.toString('utf8')); } catch { return { violation: 'Malformed JSON response' }; }
	for (const [name, expected] of Object.entries(rule.fields ?? {})) {
		if (!data || !Object.hasOwn(data, name) || typeOf(data[name]) !== expected) return { violation: 'Required response field missing or wrong type' };
	}
	for (const [name, expected] of Object.entries(rule.values ?? {})) {
		if (!data || !Object.hasOwn(data, name) || data[name] !== expected) return { violation: 'Approved response value did not match' };
	}
	return {};
}
