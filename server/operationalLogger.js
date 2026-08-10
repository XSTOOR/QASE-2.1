const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const SAFE_FIELDS = new Set([
	'requestId', 'method', 'route', 'statusCode', 'durationMs', 'workerId',
	'signal', 'errorName', 'port', 'host', 'executionMode', 'storeMode',
	'authenticationMode', 'provider', 'model', 'registered', 'consecutiveFailures'
]);

function safeName(value, label, pattern, maximum) {
	const result = String(value ?? '').trim();
	if (!result || result.length > maximum || !pattern.test(result)) throw new TypeError(`${label} is invalid.`);
	return result;
}

function safeFields(fields) {
	if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {};
	const result = {};
	for (const [key, value] of Object.entries(fields)) {
		if (!SAFE_FIELDS.has(key) || value === undefined || value === null) continue;
		if (typeof value === 'number') {
			if (Number.isFinite(value)) result[key] = value;
		} else if (typeof value === 'boolean') {
			result[key] = value;
		} else {
			result[key] = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
		}
	}
	return result;
}

export function createOperationalLogger(options = {}) {
	const environment = options.environment ?? process.env;
	const component = safeName(options.component, 'logger component', /^[a-z][a-z0-9-]*$/, 64);
	const format = String(options.format ?? environment.QASE_LOG_FORMAT
		?? (environment.NODE_ENV === 'production' ? 'json' : 'text')).trim().toLowerCase();
	if (!['json', 'text'].includes(format)) throw new TypeError('QASE_LOG_FORMAT must be json or text.');
	const minimum = String(options.level ?? environment.QASE_LOG_LEVEL ?? 'info').trim().toLowerCase();
	if (!(minimum in LEVELS)) throw new TypeError('QASE_LOG_LEVEL is invalid.');
	const now = options.now ?? (() => new Date());
	const write = options.write ?? (line => console.log(line));
	if (typeof write !== 'function') throw new TypeError('Logger output must be a function.');

	function log(severity, event, fields) {
		if (LEVELS[severity] < LEVELS[minimum]) return;
		const safeEvent = safeName(event, 'log event', /^[a-z][a-z0-9.-]*$/, 96);
		const record = {
			timestamp: now().toISOString(),
			severity,
			component,
			event: safeEvent,
			...safeFields(fields)
		};
		write(format === 'json'
			? JSON.stringify(record)
			: `${record.timestamp} ${severity.toUpperCase()} [${component}] ${safeEvent}${Object.keys(fields ?? {}).length ? ` ${JSON.stringify(safeFields(fields))}` : ''}`
		);
	}

	return Object.freeze({
		debug: (event, fields) => log('debug', event, fields),
		info: (event, fields) => log('info', event, fields),
		warn: (event, fields) => log('warn', event, fields),
		error: (event, fields) => log('error', event, fields)
	});
}
