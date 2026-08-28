import { randomUUID, timingSafeEqual } from 'node:crypto';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const DURATION_BUCKETS = Object.freeze([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);

function boundedInteger(value, fallback, minimum, maximum, label) {
	const result = value === undefined || value === '' ? fallback : Number(value);
	if (!Number.isInteger(result) || result < minimum || result > maximum) {
		throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
	}
	return result;
}

function metricToken(environment) {
	const token = String(environment.QASE_METRICS_TOKEN ?? '').trim();
	if (token && Buffer.byteLength(token, 'utf8') < 32) {
		throw new TypeError('QASE_METRICS_TOKEN must contain at least 32 bytes.');
	}
	return token;
}

function sameToken(expected, actual) {
	const expectedBytes = Buffer.from(expected);
	const actualBytes = Buffer.from(actual);
	return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function requestRoute(request, overloaded = false) {
	if (overloaded) return 'overload';
	const path = request.route?.path;
	if (typeof path !== 'string') return 'unmatched';
	return `${request.baseUrl ?? ''}${path}` || '/';
}

function labels(values) {
	return `{${Object.entries(values).map(([name, value]) =>
		`${name}="${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`
	).join(',')}}`;
}

function finite(value) {
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function createOperationalControls(options = {}) {
	const environment = options.environment ?? process.env;
	const token = options.metricsToken === undefined
		? metricToken(environment)
		: metricToken({ QASE_METRICS_TOKEN: options.metricsToken });
	const mutationLimit = boundedInteger(
		options.mutationLimit ?? environment.QASE_MUTATION_MAX_IN_FLIGHT,
		64, 1, 10_000, 'QASE_MUTATION_MAX_IN_FLIGHT'
	);
	const mutationPrefixes = options.mutationPrefixes ?? ['/api/', '/internal/v1/drytis/'];
	if (!Array.isArray(mutationPrefixes) || mutationPrefixes.length === 0
		|| mutationPrefixes.some(prefix => typeof prefix !== 'string' || !prefix.startsWith('/') || !prefix.endsWith('/'))) {
		throw new TypeError('mutationPrefixes must contain absolute path prefixes ending in /.');
	}
	const now = options.now ?? (() => process.hrtime.bigint());
	const logger = options.logger;
	if (logger !== undefined && typeof logger?.info !== 'function') throw new TypeError('Operational logger is invalid.');
	const startedAt = options.startedAt ?? Date.now();
	const requests = new Map();
	const durations = new Map();
	let mutationInFlight = 0;
	let overloads = 0;

	function observe(method, route, statusCode, seconds) {
		const statusClass = `${Math.floor(statusCode / 100)}xx`;
		const key = JSON.stringify([method, route, statusClass]);
		requests.set(key, (requests.get(key) ?? 0) + 1);
		let record = durations.get(key);
		if (!record) {
			record = { count: 0, sum: 0, buckets: DURATION_BUCKETS.map(() => 0) };
			durations.set(key, record);
		}
		record.count += 1;
		record.sum += seconds;
		for (let index = 0; index < DURATION_BUCKETS.length; index++) {
			if (seconds <= DURATION_BUCKETS[index]) record.buckets[index] += 1;
		}
	}

	function middleware(request, response, next) {
		const requestId = randomUUID();
		request.qaseRequestId = requestId;
		response.setHeader('X-Request-Id', requestId);
		const started = now();
		const mutation = mutationPrefixes.some(prefix => request.path.startsWith(prefix))
			&& UNSAFE_METHODS.has(request.method);
		const overloaded = mutation && mutationInFlight >= mutationLimit;
		if (mutation && !overloaded) mutationInFlight += 1;
		if (overloaded) overloads += 1;
		let finished = false;
		const finalize = () => {
			if (finished) return;
			finished = true;
			if (mutation && !overloaded) mutationInFlight -= 1;
			const elapsed = Number(now() - started) / 1_000_000_000;
			const route = requestRoute(request, overloaded);
			observe(request.method, route, response.statusCode, Math.max(0, elapsed));
			logger?.info('http.request.completed', {
				requestId,
				method: request.method,
				route,
				statusCode: response.statusCode,
				durationMs: Math.max(0, elapsed * 1_000)
			});
		};
		response.once('finish', finalize);
		response.once('close', finalize);
		if (overloaded) {
			response.setHeader('Retry-After', '1');
			response.status(503).json({ error: 'This Qase server is at its request capacity. Retry shortly.' });
			return;
		}
		next();
	}

	async function render(queue) {
		const lines = [
			'# HELP qase_process_uptime_seconds Process uptime in seconds.',
			'# TYPE qase_process_uptime_seconds gauge',
			`qase_process_uptime_seconds ${Math.max(0, (Date.now() - startedAt) / 1000)}`,
			'# HELP qase_process_resident_memory_bytes Resident memory in bytes.',
			'# TYPE qase_process_resident_memory_bytes gauge',
			`qase_process_resident_memory_bytes ${process.memoryUsage().rss}`,
			'# HELP qase_http_mutations_in_flight Mutating API requests currently executing.',
			'# TYPE qase_http_mutations_in_flight gauge',
			`qase_http_mutations_in_flight ${mutationInFlight}`,
			'# HELP qase_http_overload_rejections_total Mutating requests rejected by the local concurrency guard.',
			'# TYPE qase_http_overload_rejections_total counter',
			`qase_http_overload_rejections_total ${overloads}`,
			'# HELP qase_http_requests_total HTTP requests by normalized route and status class.',
			'# TYPE qase_http_requests_total counter'
		];
		for (const [key, count] of [...requests.entries()].sort()) {
			const [method, route, statusClass] = JSON.parse(key);
			lines.push(`qase_http_requests_total${labels({ method, route, status_class: statusClass })} ${count}`);
		}
		lines.push(
			'# HELP qase_http_request_duration_seconds HTTP request duration by normalized route.',
			'# TYPE qase_http_request_duration_seconds histogram'
		);
		for (const [key, record] of [...durations.entries()].sort()) {
			const [method, route, statusClass] = JSON.parse(key);
			const base = { method, route, status_class: statusClass };
			for (let index = 0; index < DURATION_BUCKETS.length; index++) {
				lines.push(`qase_http_request_duration_seconds_bucket${labels({ ...base, le: DURATION_BUCKETS[index] })} ${record.buckets[index]}`);
			}
			lines.push(`qase_http_request_duration_seconds_bucket${labels({ ...base, le: '+Inf' })} ${record.count}`);
			lines.push(`qase_http_request_duration_seconds_sum${labels(base)} ${record.sum}`);
			lines.push(`qase_http_request_duration_seconds_count${labels(base)} ${record.count}`);
		}

		if (queue?.stats) {
			const stats = await queue.stats();
			lines.push(
				'# HELP qase_execution_jobs Current durable execution jobs by state.',
				'# TYPE qase_execution_jobs gauge'
			);
			for (const status of ['queued', 'leased', 'cancel_requested', 'succeeded', 'failed', 'cancelled']) {
				lines.push(`qase_execution_jobs${labels({ status })} ${finite(stats[status])}`);
			}
			lines.push(
				'# HELP qase_execution_oldest_queued_age_seconds Age of the oldest queued job.',
				'# TYPE qase_execution_oldest_queued_age_seconds gauge',
				`qase_execution_oldest_queued_age_seconds ${finite(stats.oldestQueuedAgeSeconds)}`,
				'# HELP qase_execution_expired_leases Leases whose heartbeat deadline has passed.',
				'# TYPE qase_execution_expired_leases gauge',
				`qase_execution_expired_leases ${finite(stats.expiredLeases)}`
			);
		}
		return `${lines.join('\n')}\n`;
	}

	function mount(app, dependencies = {}) {
		if (!token) return;
		app.get('/metrics', async (request, response, next) => {
			const authorization = String(request.headers.authorization ?? '');
			const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
			if (!sameToken(token, supplied)) {
				response.setHeader('Cache-Control', 'no-store');
				response.status(401).type('text/plain').send('Unauthorized\n');
				return;
			}
			try {
				response.setHeader('Cache-Control', 'no-store');
				response.type('text/plain; version=0.0.4; charset=utf-8').send(await render(dependencies.queue));
			} catch (error) { next(error); }
		});
	}

	return Object.freeze({ middleware, mount, render, mutationLimit, metricsEnabled: Boolean(token) });
}
