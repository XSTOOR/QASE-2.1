const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function positiveInteger(value, fallback, maximum, label) {
	const result = value === undefined || value === '' ? fallback : Number(value);
	if (!Number.isInteger(result) || result < 1 || result > maximum) {
		throw new TypeError(`${label} must be an integer from 1 to ${maximum}.`);
	}
	return result;
}

function httpUrl(value, label, allowedPaths) {
	let parsed;
	try { parsed = new URL(String(value ?? '').trim()); } catch { throw new TypeError(`${label} must be a valid HTTP(S) URL.`); }
	if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new TypeError(`${label} must be an HTTP(S) URL without credentials, query, or fragment.`);
	}
	if (allowedPaths && !allowedPaths.has(parsed.pathname)) throw new TypeError(`${label} has an unsupported path.`);
	return parsed;
}

export function createSmokeConfig(environment = process.env) {
	const input = String(environment.QASE_SMOKE_TARGETS ?? '').trim();
	if (!input) throw new TypeError('QASE_SMOKE_TARGETS is required.');
	const targets = input.split(',').map(entry => {
		const separator = entry.indexOf('=');
		if (separator < 1) throw new TypeError('Each smoke target must use name=https://host/readyz.');
		const name = entry.slice(0, separator).trim();
		if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new TypeError('Smoke target name is invalid.');
		return Object.freeze({
			name,
			url: httpUrl(entry.slice(separator + 1), `smoke target ${name}`, new Set(['/healthz', '/readyz'])).href
		});
	});
	if (targets.length > 20 || new Set(targets.map(target => target.name)).size !== targets.length) {
		throw new TypeError('Smoke targets must contain at most 20 unique names.');
	}
	return Object.freeze({ targets: Object.freeze(targets), timeoutMs: positiveInteger(environment.QASE_CHECK_TIMEOUT_MS, 5_000, 30_000, 'QASE_CHECK_TIMEOUT_MS') });
}

export async function runSmokeChecks(options = {}) {
	const config = options.config ?? createSmokeConfig(options.environment);
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	return Promise.all(config.targets.map(async target => {
		const started = performance.now();
		try {
			const response = await fetchImpl(target.url, { redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs) });
			await response.body?.cancel();
			return Object.freeze({ name: target.name, ok: response.ok, status: response.status, durationMs: performance.now() - started });
		} catch (error) {
			return Object.freeze({ name: target.name, ok: false, status: 0, durationMs: performance.now() - started, error: error.name ?? 'Error' });
		}
	}));
}

export function createPlacementLoadConfig(environment = process.env) {
	const control = httpUrl(environment.QASE_LOAD_CONTROL_URL, 'QASE_LOAD_CONTROL_URL');
	if (control.pathname !== '/') throw new TypeError('QASE_LOAD_CONTROL_URL must be an origin without a path.');
	const organizationId = String(environment.QASE_LOAD_ORGANIZATION_ID ?? '').toLowerCase();
	const projectId = String(environment.QASE_LOAD_PROJECT_ID ?? '').toLowerCase();
	if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(projectId) || organizationId === projectId) {
		throw new TypeError('Load organization/project IDs must be distinct canonical UUIDs.');
	}
	const token = String(environment.QASE_CONTROL_API_READ_TOKEN ?? '').trim();
	if (Buffer.byteLength(token, 'utf8') < 32) throw new TypeError('QASE_CONTROL_API_READ_TOKEN must contain at least 32 bytes.');
	return Object.freeze({
		url: `${control.origin}/internal/v1/placements/${organizationId}/${projectId}`,
		token,
		requests: positiveInteger(environment.QASE_LOAD_REQUESTS, 1_000, 10_000, 'QASE_LOAD_REQUESTS'),
		concurrency: positiveInteger(environment.QASE_LOAD_CONCURRENCY, 20, 200, 'QASE_LOAD_CONCURRENCY'),
		timeoutMs: positiveInteger(environment.QASE_CHECK_TIMEOUT_MS, 5_000, 30_000, 'QASE_CHECK_TIMEOUT_MS')
	});
}

function percentile(sorted, fraction) {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export async function runPlacementLoad(options = {}) {
	const config = options.config ?? createPlacementLoadConfig(options.environment);
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const durations = [];
	const statuses = new Map();
	let next = 0;
	async function worker() {
		while (next < config.requests) {
			next += 1;
			const started = performance.now();
			let status = 0;
			try {
				const response = await fetchImpl(config.url, {
					headers: { authorization: `Bearer ${config.token}` },
					redirect: 'error', signal: AbortSignal.timeout(config.timeoutMs)
				});
				status = response.status;
				await response.body?.cancel();
			} catch { status = 0; }
			durations.push(performance.now() - started);
			statuses.set(status, (statuses.get(status) ?? 0) + 1);
		}
	}
	const started = performance.now();
	await Promise.all(Array.from({ length: Math.min(config.concurrency, config.requests) }, worker));
	durations.sort((left, right) => left - right);
	const elapsedMs = performance.now() - started;
	return Object.freeze({
		requests: config.requests,
		elapsedMs,
		requestsPerSecond: elapsedMs > 0 ? (config.requests * 1_000) / elapsedMs : 0,
		p50Ms: percentile(durations, 0.50),
		p95Ms: percentile(durations, 0.95),
		p99Ms: percentile(durations, 0.99),
		statuses: Object.fromEntries([...statuses.entries()].sort(([left], [right]) => left - right))
	});
}
