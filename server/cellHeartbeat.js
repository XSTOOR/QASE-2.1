const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REGION_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function required(value, label) {
	const result = String(value ?? '').trim();
	if (!result) throw new TypeError(`${label} is required.`);
	return result;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
	const result = value === undefined || value === '' ? fallback : Number(value);
	if (!Number.isInteger(result) || result < minimum || result > maximum) {
		throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
	}
	return result;
}

function token(value, label) {
	const result = required(value, label);
	if (Buffer.byteLength(result, 'utf8') < 32) throw new TypeError(`${label} must contain at least 32 bytes.`);
	return result;
}

function endpoint(value, label, pathRequired = false, httpsOnly = false) {
	let parsed;
	try { parsed = new URL(required(value, label)); } catch { throw new TypeError(`${label} must be a valid HTTP(S) URL.`); }
	if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new TypeError(`${label} must be an HTTP(S) URL without credentials, query, or fragment.`);
	}
	if (httpsOnly && parsed.protocol !== 'https:') throw new TypeError(`${label} must use HTTPS.`);
	if (pathRequired && parsed.pathname !== '/metrics') throw new TypeError(`${label} must end with /metrics.`);
	if (!pathRequired && parsed.pathname !== '/') throw new TypeError(`${label} must be an origin without a path.`);
	return pathRequired ? parsed.href : parsed.origin;
}

export function createCellHeartbeatConfig(environment = process.env) {
	const id = required(environment.QASE_CELL_ID, 'QASE_CELL_ID').toLowerCase();
	if (!UUID_PATTERN.test(id)) throw new TypeError('QASE_CELL_ID must be a canonical UUID.');
	const organizationId = required(environment.QASE_BOOTSTRAP_ORGANIZATION_ID, 'QASE_BOOTSTRAP_ORGANIZATION_ID').toLowerCase();
	const projectId = required(environment.QASE_BOOTSTRAP_PROJECT_ID, 'QASE_BOOTSTRAP_PROJECT_ID').toLowerCase();
	if (!UUID_PATTERN.test(organizationId)) throw new TypeError('QASE_BOOTSTRAP_ORGANIZATION_ID must be a canonical UUID.');
	if (!UUID_PATTERN.test(projectId)) throw new TypeError('QASE_BOOTSTRAP_PROJECT_ID must be a canonical UUID.');
	if (organizationId === projectId) throw new TypeError('Cell organization and project IDs must differ.');
	const region = required(environment.QASE_CELL_REGION, 'QASE_CELL_REGION').toLowerCase();
	if (!REGION_PATTERN.test(region)) throw new TypeError('QASE_CELL_REGION must be a DNS-safe slug.');
	const name = required(environment.QASE_CELL_NAME, 'QASE_CELL_NAME');
	if (name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw new TypeError('QASE_CELL_NAME is invalid.');
	return Object.freeze({
		id,
		organizationId,
		projectId,
		name,
		region,
		baseUrl: endpoint(environment.QASE_CELL_PUBLIC_URL, 'QASE_CELL_PUBLIC_URL', false, true),
		controlUrl: endpoint(environment.QASE_CONTROL_URL, 'QASE_CONTROL_URL'),
		metricsUrl: endpoint(environment.QASE_CELL_METRICS_URL, 'QASE_CELL_METRICS_URL', true),
		controlToken: token(environment.QASE_CONTROL_API_WRITE_TOKEN, 'QASE_CONTROL_API_WRITE_TOKEN'),
		metricsToken: token(environment.QASE_METRICS_TOKEN, 'QASE_METRICS_TOKEN'),
		capacityWeight: boundedInteger(environment.QASE_CELL_CAPACITY_WEIGHT, 100, 1, 1_000, 'QASE_CELL_CAPACITY_WEIGHT'),
		intervalMs: boundedInteger(environment.QASE_CELL_HEARTBEAT_INTERVAL_MS, 30_000, 5_000, 300_000, 'QASE_CELL_HEARTBEAT_INTERVAL_MS'),
		timeoutMs: boundedInteger(environment.QASE_CELL_HEARTBEAT_TIMEOUT_MS, 5_000, 500, 30_000, 'QASE_CELL_HEARTBEAT_TIMEOUT_MS')
	});
}

function metricValue(text, metric, label) {
	const line = text.split(/\r?\n/).find(candidate => candidate.startsWith(`${metric}${label ?? ''} `));
	if (!line) throw new Error(`Required metric ${metric}${label ?? ''} was not returned.`);
	const value = Number(line.slice(line.lastIndexOf(' ') + 1));
	if (!Number.isFinite(value) || value < 0) throw new Error(`Metric ${metric} is invalid.`);
	return value;
}

export function parseCellMetrics(text) {
	if (typeof text !== 'string' || text.length > 2_000_000) throw new Error('Metrics response is invalid or too large.');
	return Object.freeze({
		queueDepth: Math.floor(metricValue(text, 'qase_execution_jobs', '{status="queued"}')),
		oldestQueuedAgeSeconds: metricValue(text, 'qase_execution_oldest_queued_age_seconds')
	});
}

async function readBoundedText(response, maximumBytes = 2_000_000) {
	if (!response.body) return '';
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = '';
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maximumBytes) throw new Error('Metrics response is invalid or too large.');
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally { reader.releaseLock(); }
}

async function checkedFetch(fetchImpl, url, options, timeoutMs) {
	const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) {
		await response.body?.cancel();
		const error = new Error(`Upstream request failed with HTTP ${response.status}.`);
		error.status = response.status;
		throw error;
	}
	return response;
}

export function createCellHeartbeatController(options = {}) {
	const config = options.config ?? createCellHeartbeatConfig(options.environment);
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const now = options.now ?? Date.now;
	const setTimer = options.setTimer ?? setTimeout;
	const clearTimer = options.clearTimer ?? clearTimeout;
	const random = options.random ?? Math.random;
	const onError = options.onError ?? (() => undefined);
	if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
	let timer;
	let running = false;
	let stopping = false;
	let lastAttemptAt = 0;
	let lastSuccessAt = 0;
	let consecutiveFailures = 0;
	let registered = false;

	async function publish(method, path, body) {
		const response = await checkedFetch(fetchImpl, `${config.controlUrl}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${config.controlToken}`,
				'content-type': 'application/json'
			},
			body: JSON.stringify(body)
		}, config.timeoutMs);
		await response.body?.cancel();
	}

	async function runOnce({ register = false } = {}) {
		if (running || stopping) return false;
		running = true;
		lastAttemptAt = now();
		try {
			if (register || !registered) {
				await publish('PUT', `/internal/v1/cells/${config.id}`, {
					name: config.name,
					region: config.region,
					baseUrl: config.baseUrl,
					organizationId: config.organizationId,
					projectId: config.projectId,
					capacityWeight: config.capacityWeight
				});
				registered = true;
			}
			const metrics = await checkedFetch(fetchImpl, config.metricsUrl, {
				headers: { authorization: `Bearer ${config.metricsToken}` }
			}, config.timeoutMs);
			const observations = parseCellMetrics(await readBoundedText(metrics));
			await publish('POST', `/internal/v1/cells/${config.id}/heartbeat`, observations);
			lastSuccessAt = now();
			consecutiveFailures = 0;
			return true;
		} catch (error) {
			if (error?.status === 404) registered = false;
			consecutiveFailures += 1;
			onError(error);
			return false;
		} finally { running = false; }
	}

	function delay() {
		const exponent = Math.min(consecutiveFailures, 4);
		const backoff = Math.min(config.intervalMs * (2 ** exponent), 300_000);
		return Math.floor(backoff * (0.8 + (random() * 0.4)));
	}

	async function cycle(register = false) {
		await runOnce({ register });
		if (!stopping) timer = setTimer(() => cycle(false), delay());
	}

	return Object.freeze({
		async start() {
			if (timer || running) return;
			stopping = false;
			await cycle(true);
		},
		stop() {
			stopping = true;
			if (timer) clearTimer(timer);
			timer = undefined;
		},
		runOnce,
		getState() {
			return Object.freeze({
				running,
				stopping,
				lastAttemptAt,
				lastSuccessAt,
				consecutiveFailures,
				registered,
				ready: !stopping && lastSuccessAt > 0 && now() - lastSuccessAt <= config.intervalMs * 3
			});
		}
	});
}
