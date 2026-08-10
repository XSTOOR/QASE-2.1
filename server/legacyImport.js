import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const DEFAULT_MAX_LEGACY_BYTES = 32 * 1024 * 1024;

const RUN_STATUSES = new Set([
	'idle', 'running', 'awaiting_input', 'interrupted', 'error', 'done'
]);
const ACTIVITY_STATUSES = new Set(['running', 'done', 'failed']);
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
const VERDICTS = new Set(['pass', 'pass_with_issues', 'fail', 'blocked']);
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUSPICIOUS_KEY = /(?:password|passcode|api[_-]?key|authorization|cookie|credential|secret|token)/i;
const LIVE_ONLY_KEYS = new Set(['runtime', 'bridge', 'controller', 'frame']);
const REDACTED = '[REDACTED]';

function fail(location, problem) {
	throw new TypeError(`${location} ${problem}`);
}

function object(value, location) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		fail(location, 'must be an object.');
	}
	return value;
}

function requiredString(value, location, redact) {
	if (typeof value !== 'string') {
		fail(location, 'must be a string.');
	}
	return redact(value);
}

function optionalString(value, location, redact) {
	return value === undefined ? undefined : requiredString(value, location, redact);

}

function timestamp(value, location) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		fail(location, 'must be a finite nonnegative millisecond timestamp.');
	}
	return value;
}

function nonnegativeNumber(value, location) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		fail(location, 'must be a finite nonnegative number.');
	}
	return value;

}

function nonnegativeInteger(value, location) {
	const number = nonnegativeNumber(value, location);
	if (!Number.isInteger(number)) {
		fail(location, 'must be an integer.');
	}
	return number;

}

function optionalBoolean(value, location) {
	if (value === undefined) return undefined;
	if (typeof value !== 'boolean') fail(location, 'must be a boolean.');
	return value;

}

function array(value, location, { missing = false } = {}) {
	if (value === undefined && missing) return [];
	if (!Array.isArray(value)) fail(location, 'must be an array.');
	return value;

}

function stringArray(value, location, redact, options) {
	return array(value, location, options).map((item, index) =>
		requiredString(item, `${location}[${index}]`, redact));

}

function collectStrings(value, output, depth = 0) {
	if (depth > 32) return;
	if (typeof value === 'string' && value.length > 0) {
		output.add(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectStrings(item, output, depth + 1);
		return;
	}
	if (value && typeof value === 'object') {
		for (const item of Object.values(value)) collectStrings(item, output, depth + 1);
	}
}

function credentialValues(value, output = new Set(), depth = 0) {
	if (depth > 32 || !value || typeof value !== 'object') return output;
	if (Array.isArray(value)) {
		for (const item of value) credentialValues(item, output, depth + 1);
		return output;
	}
	for (const [key, item] of Object.entries(value)) {
		if (key !== 'secretNames' && SUSPICIOUS_KEY.test(key)) {
			collectStrings(item, output, depth + 1);
		} else {
			credentialValues(item, output, depth + 1);
		}
	}
	return output;
}

function createRedactor(values) {
	const ordered = [...values].sort((left, right) => right.length - left.length);
	return input => {
		let result = input;
		for (const value of ordered) {
			if (result.includes(value)) result = result.split(value).join(REDACTED);
		}
		return result;
	};

}

/** Copies arbitrary JSON tool input while dropping live and credential-shaped keys. */
function safeJson(value, location, redact, depth = 0) {
	if (depth > 32) fail(location, 'is nested too deeply.');
	if (value === null || typeof value === 'boolean') return value;
	if (typeof value === 'string') return redact(value);
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) fail(location, 'contains a non-finite number.');
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item, index) => safeJson(item, `${location}[${index}]`, redact, depth + 1));
	}
	if (value && typeof value === 'object') {
		const output = {};
		for (const [key, item] of Object.entries(value)) {
			if (LIVE_ONLY_KEYS.has(key) || SUSPICIOUS_KEY.test(key)) continue;
			output[key] = safeJson(item, `${location}.${key}`, redact, depth + 1);
		}
		return output;
	}
	fail(location, 'contains an unsupported value.');

}

function prepareMessages(value, location, redact, summary) {
	const output = [];
	for (const [index, candidate] of array(value, location, { missing: true }).entries()) {
		const entry = object(candidate, `${location}[${index}]`);
		if (entry.role === 'thinking') {
			summary.removedThinkingMessages += 1;
			continue;
		}
		output.push({
			id: requiredString(entry.id, `${location}[${index}].id`, redact),
			ts: timestamp(entry.ts, `${location}[${index}].ts`),
			role: requiredString(entry.role, `${location}[${index}].role`, redact),
			text: requiredString(entry.text, `${location}[${index}].text`, redact),
			kind: optionalString(entry.kind, `${location}[${index}].kind`, redact)
		});
	}
	return output;
}

function prepareActivities(value, location, redact) {
	return array(value, location, { missing: true }).map((candidate, index) => {
		const entry = object(candidate, `${location}[${index}]`);
		const status = requiredString(entry.status, `${location}[${index}].status`, redact);
		if (!ACTIVITY_STATUSES.has(status)) fail(`${location}[${index}].status`, 'is unsupported.');
		return {
			id: requiredString(entry.id, `${location}[${index}].id`, redact),
			ts: timestamp(entry.ts, `${location}[${index}].ts`),
			status,
			type: optionalString(entry.type, `${location}[${index}].type`, redact),
			toolName: optionalString(entry.toolName, `${location}[${index}].toolName`, redact),
			label: optionalString(entry.label, `${location}[${index}].label`, redact),
			detail: optionalString(entry.detail, `${location}[${index}].detail`, redact),
			input: entry.input === undefined
				? undefined
				: safeJson(entry.input, `${location}[${index}].input`, redact),
			error: optionalString(entry.error, `${location}[${index}].error`, redact),
			summary: optionalString(entry.summary, `${location}[${index}].summary`, redact)
		};
	});
}

function prepareFindings(value, location, redact) {
	return array(value, location, { missing: true }).map((candidate, index) => {
		const entry = object(candidate, `${location}[${index}]`);
		const severity = requiredString(entry.severity, `${location}[${index}].severity`, redact);
		if (!SEVERITIES.has(severity)) fail(`${location}[${index}].severity`, 'is unsupported.');
		return {
			id: requiredString(entry.id, `${location}[${index}].id`, redact),
			ts: timestamp(entry.ts, `${location}[${index}].ts`),
			title: requiredString(entry.title, `${location}[${index}].title`, redact),
			severity,
			category: requiredString(entry.category, `${location}[${index}].category`, redact),
			url: optionalString(entry.url, `${location}[${index}].url`, redact),
			steps: stringArray(entry.steps, `${location}[${index}].steps`, redact, { missing: true }),
			expected: requiredString(entry.expected, `${location}[${index}].expected`, redact),
			actual: requiredString(entry.actual, `${location}[${index}].actual`, redact),
			evidence: optionalString(entry.evidence, `${location}[${index}].evidence`, redact)
		};
	});
}

function prepareTodos(value, location, redact) {
	return array(value, location, { missing: true }).map((candidate, index) => {
		const entry = object(candidate, `${location}[${index}]`);
		const status = requiredString(entry.status, `${location}[${index}].status`, redact);
		if (!TODO_STATUSES.has(status)) fail(`${location}[${index}].status`, 'is unsupported.');
		return {
			text: requiredString(entry.text, `${location}[${index}].text`, redact),
			status
		};
	});
}

function prepareReport(value, location, redact) {
	if (value === undefined) return undefined;
	const report = object(value, location);
	const verdict = requiredString(report.verdict, `${location}.verdict`, redact);
	if (!VERDICTS.has(verdict)) fail(`${location}.verdict`, 'is unsupported.');
	const bySeverityInput = object(report.bySeverity, `${location}.bySeverity`);
	const bySeverity = {};
	for (const severity of SEVERITIES) {
		bySeverity[severity] = nonnegativeInteger(
			bySeverityInput[severity] ?? 0,
			`${location}.bySeverity.${severity}`
		);
	}
	return {
		ts: timestamp(report.ts, `${location}.ts`),
		verdict,
		summary: requiredString(report.summary, `${location}.summary`, redact),
		covered: stringArray(report.covered, `${location}.covered`, redact, { missing: true }),
		notCovered: stringArray(report.notCovered, `${location}.notCovered`, redact, { missing: true }),
		recommendations: stringArray(report.recommendations, `${location}.recommendations`, redact, { missing: true }),
		targetUrl: optionalString(report.targetUrl, `${location}.targetUrl`, redact),
		findings: nonnegativeInteger(report.findings, `${location}.findings`),
		bySeverity
	};
}

function preparePendingQuestion(value, location, redact) {
	if (value === undefined) return undefined;
	const pending = object(value, location);
	const options = array(pending.options, `${location}.options`, { missing: true }).map((candidate, index) => {
		const option = object(candidate, `${location}.options[${index}]`);
		return {
			label: requiredString(option.label, `${location}.options[${index}].label`, redact),
			description: optionalString(option.description, `${location}.options[${index}].description`, redact)
		};
	});
	return {
		toolCallId: optionalString(pending.toolCallId, `${location}.toolCallId`, redact),
		question: requiredString(pending.question, `${location}.question`, redact),
		summary: optionalString(pending.summary, `${location}.summary`, redact),
		options,
		allowCustom: optionalBoolean(pending.allowCustom, `${location}.allowCustom`),
		customLabel: optionalString(pending.customLabel, `${location}.customLabel`, redact),
		placeholder: optionalString(pending.placeholder, `${location}.placeholder`, redact),
		credentialLike: optionalBoolean(pending.credentialLike, `${location}.credentialLike`)
	};
}

function prepareContextUsage(value, location) {
	if (value === undefined) return undefined;
	const context = object(value, location);
	const percentage = nonnegativeNumber(context.percentage, `${location}.percentage`);
	if (percentage > 100) fail(`${location}.percentage`, 'must not exceed 100.');
	return {
		percentage,
		used: nonnegativeNumber(context.used, `${location}.used`),
		window: nonnegativeNumber(context.window, `${location}.window`)
	};
}

function sourceBuffer(raw) {
	if (typeof raw === 'string') return Buffer.from(raw, 'utf8');
	if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) return Buffer.from(raw);
	throw new TypeError('Legacy session source must be a JSON string or byte buffer.');
}

function maxBytes(value) {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError('maxBytes must be a positive safe integer.');
	}
	return value;
}

/**
 * Validates and prepares legacy session JSON without writing to a repository.
 * The returned summary is a dry run; callers may inspect it before any later
 * import phase commits the prepared aggregates.
 */
export function prepareLegacySessions(raw, options = {}) {
	const bytes = sourceBuffer(raw);
	const limit = maxBytes(options.maxBytes ?? DEFAULT_MAX_LEGACY_BYTES);
	if (bytes.byteLength > limit) {
		throw new RangeError(`Legacy session source exceeds the configured ${limit}-byte limit.`);
	}

	const sourceHash = createHash('sha256').update(bytes).digest('hex');
	let parsed;
	try {
		parsed = JSON.parse(bytes.toString('utf8'));
	} catch {
		throw new TypeError('Legacy session source is not valid JSON.');
	}
	if (!Array.isArray(parsed)) {
		throw new TypeError('Legacy session source must contain a top-level array.');
	}

	const redact = createRedactor(credentialValues(parsed));
	const seen = new Set();
	const summary = {
		dryRun: true,
		sourceHash,
		sourceBytes: bytes.byteLength,
		inputSessions: parsed.length,
		preparedSessions: 0,
		interruptedSessions: 0,
		removedThinkingMessages: 0,
		clearedSecretNameEntries: 0
	};

	const sessions = parsed.map((candidate, index) => {
		const location = `Legacy session[${index}]`;
		const input = object(candidate, location);
		if (typeof input.id !== 'string' || !CANONICAL_UUID.test(input.id)) {
			fail(`${location}.id`, 'must be a canonical UUID.');
		}
		if (seen.has(input.id)) fail(`${location}.id`, 'is duplicated in the source.');
		seen.add(input.id);

		const status = requiredString(input.status, `${location}.status`, redact);
		if (!RUN_STATUSES.has(status)) fail(`${location}.status`, 'is unsupported.');
		const interrupted = status === 'running' || status === 'awaiting_input';
		if (interrupted) summary.interruptedSessions += 1;
		if (Array.isArray(input.secretNames)) summary.clearedSecretNameEntries += input.secretNames.length;

		return {
			id: input.id,
			title: requiredString(input.title, `${location}.title`, redact),
			createdAt: timestamp(input.createdAt, `${location}.createdAt`),
			updatedAt: timestamp(input.updatedAt, `${location}.updatedAt`),
			status: interrupted ? 'interrupted' : status,
			targetUrl: optionalString(input.targetUrl, `${location}.targetUrl`, redact),
			messages: prepareMessages(input.messages, `${location}.messages`, redact, summary),
			activities: prepareActivities(input.activities, `${location}.activities`, redact),
			findings: prepareFindings(input.findings, `${location}.findings`, redact),
			todos: prepareTodos(input.todos, `${location}.todos`, redact),
			report: prepareReport(input.report, `${location}.report`, redact),
			pendingQuestion: interrupted
				? undefined
				: preparePendingQuestion(input.pendingQuestion, `${location}.pendingQuestion`, redact),
			contextUsage: prepareContextUsage(input.contextUsage, `${location}.contextUsage`),
			secretNames: []
		};
	});

	summary.preparedSessions = sessions.length;
	return {
		source: {
			path: options.sourcePath === undefined ? undefined : path.resolve(String(options.sourcePath)),
			bytes: bytes.byteLength,
			sha256: sourceHash
		},
		summary: Object.freeze(summary),
		sessions
	};
}

/** Reads a legacy JSON file without modifying it, then performs a dry run. */
export function readLegacySessions(filePath, options = {}) {
	if (typeof filePath !== 'string' || filePath.trim() === '') {
		throw new TypeError('Legacy session file path is required.');
	}
	const limit = maxBytes(options.maxBytes ?? DEFAULT_MAX_LEGACY_BYTES);
	const stat = fs.statSync(filePath);
	if (!stat.isFile()) throw new TypeError('Legacy session source must be a regular file.');
	if (stat.size > limit) {
		throw new RangeError(`Legacy session source exceeds the configured ${limit}-byte limit.`);
	}
	const raw = fs.readFileSync(filePath);
	if (raw.byteLength > limit) {
		throw new RangeError(`Legacy session source exceeds the configured ${limit}-byte limit.`);
	}
	return prepareLegacySessions(raw, { ...options, maxBytes: limit, sourcePath: filePath });
}
