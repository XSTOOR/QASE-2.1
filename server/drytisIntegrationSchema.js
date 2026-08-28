/**
 * Stable, transport-independent Drytis Studio integration contract.
 *
 * Keeping request normalization outside the Express router lets the Drytis
 * adapter, OpenAPI contract tests, and future queue consumers share one strict
 * boundary without importing HTTP or agent-runtime code.
 */
export const DRYTIS_INTEGRATION_SCHEMA_VERSION = '2026-08-1';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export class DrytisIntegrationError extends Error {
	constructor(message, { code = 'drytis_integration_error', status = 400, retryable = false, details } = {}) {
		super(message);
		this.name = 'DrytisIntegrationError';
		this.code = code;
		this.status = status;
		this.retryable = retryable;
		if (details && typeof details === 'object') this.details = details;
	}
}

export function plainObject(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function exactKeys(value, allowed, label) {
	const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
	if (unexpected.length > 0) {
		throw new DrytisIntegrationError(`${label} contains unsupported fields.`, {
			code: 'unsupported_fields', status: 400,
			details: { fields: unexpected.slice(0, 20).sort() }
		});
	}
}

function boundedString(value, label, maximum, { required = true } = {}) {
	if (value === undefined && !required) return undefined;
	if (typeof value !== 'string') {
		throw new DrytisIntegrationError(`${label} must be a string.`, { code: 'invalid_request', status: 400 });
	}
	const normalized = value.trim();
	if ((required && !normalized) || normalized.length > maximum || CONTROL_CHARACTERS.test(normalized)) {
		throw new DrytisIntegrationError(`${label} is invalid or exceeds its limit.`, { code: 'invalid_request', status: 400 });
	}
	return normalized;
}

export function canonicalUuid(value, label = 'externalReviewId') {
	if (typeof value !== 'string' || !UUID.test(value)) {
		throw new DrytisIntegrationError(`${label} must be a canonical UUID.`, { code: 'invalid_request', status: 400 });
	}
	return value;
}

export function normalizeDrytisProject(value, trustedProjectId) {
	if (!plainObject(value)) {
		throw new DrytisIntegrationError('project must be an object.', { code: 'invalid_request', status: 400 });
	}
	exactKeys(value, ['id', 'name', 'revision'], 'project');
	const project = {
		id: boundedString(value.id, 'project.id', 200),
		name: boundedString(value.name, 'project.name', 200),
		revision: boundedString(value.revision, 'project.revision', 200)
	};
	if (project.id !== trustedProjectId) {
		throw new DrytisIntegrationError('The Drytis project does not belong to this Qase cell.', {
			code: 'project_scope_mismatch', status: 403
		});
	}
	return project;
}

function optionalContextString(value, label, maximum) {
	const normalized = boundedString(value, label, maximum, { required: false });
	return normalized || undefined;
}

/**
 * Product metadata helps the QA agent choose representative coverage. Every
 * value is an untrusted label; commands, credentials, repository URLs, and
 * arbitrary metadata are intentionally excluded from this boundary.
 */
export function normalizeDrytisProjectContext(value) {
	if (value === undefined) return undefined;
	if (!plainObject(value)) {
		throw new DrytisIntegrationError('projectContext must be an object.', { code: 'invalid_request', status: 400 });
	}
	exactKeys(value, [
		'description', 'applicationType', 'primaryLanguage', 'frameworks',
		'environment', 'defaultBranch'
	], 'projectContext');
	const context = {};
	for (const [field, maximum] of [
		['description', 2_000], ['applicationType', 100], ['primaryLanguage', 100],
		['environment', 100], ['defaultBranch', 200]
	]) {
		const normalized = optionalContextString(value[field], `projectContext.${field}`, maximum);
		if (normalized !== undefined) context[field] = normalized;
	}
	if (value.frameworks !== undefined) {
		if (!Array.isArray(value.frameworks) || value.frameworks.length > 20) {
			throw new DrytisIntegrationError('projectContext.frameworks must contain at most 20 strings.', {
				code: 'invalid_request', status: 400
			});
		}
		const frameworks = [...new Set(value.frameworks.map((item, index) =>
			boundedString(item, `projectContext.frameworks[${index}]`, 100)))];
		if (frameworks.length > 0) context.frameworks = frameworks;
	}
	return context;
}

function normalizeHttpsTarget(value, required, label) {
	if (value === undefined && !required) return undefined;
	if (typeof value !== 'string' || value.length === 0 || value.length > 8_192 || value !== value.trim()) {
		throw new DrytisIntegrationError(`${label} must be a bounded HTTPS URL.`, {
			code: 'invalid_preview_url', status: 400
		});
	}
	let url;
	try { url = new URL(value); }
	catch {
		throw new DrytisIntegrationError(`${label} must be a valid HTTPS URL.`, {
			code: 'invalid_preview_url', status: 400
		});
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname) {
		throw new DrytisIntegrationError(`${label} must be an HTTPS URL without credentials, a query, or a fragment.`, {
			code: 'invalid_preview_url', status: 400
		});
	}
	return url.toString();
}

export function normalizeDrytisRequestedChecks(value) {
	if (!plainObject(value)) {
		throw new DrytisIntegrationError('requestedChecks must be an object.', { code: 'invalid_request', status: 400 });
	}
	exactKeys(value, ['blackBox', 'whiteBox'], 'requestedChecks');
	if (typeof value.blackBox !== 'boolean' || typeof value.whiteBox !== 'boolean') {
		throw new DrytisIntegrationError('requestedChecks.blackBox and requestedChecks.whiteBox must be booleans.', {
			code: 'invalid_request', status: 400
		});
	}
	if (!value.blackBox && !value.whiteBox) {
		throw new DrytisIntegrationError('At least one review check must be requested.', {
			code: 'invalid_request', status: 400
		});
	}
	return { blackBox: value.blackBox, whiteBox: value.whiteBox };
}

export function sameDrytisProject(left, right) {
	return left?.id === right?.id && left?.name === right?.name
		&& (left?.revision ?? undefined) === (right?.revision ?? undefined);
}

/** Normalize the additive Studio create envelope without inspecting source. */
export function normalizeDrytisCreateRequest(value, trustedProjectId) {
	if (!plainObject(value)) {
		throw new DrytisIntegrationError('The review request must be a JSON object.', {
			code: 'invalid_request', status: 400
		});
	}
	exactKeys(value, [
		'schemaVersion', 'externalReviewId', 'project', 'projectContext',
		'containerUrl', 'previewUrl', 'requestedChecks', 'sourceSnapshot'
	], 'Review request');
	if (value.schemaVersion !== DRYTIS_INTEGRATION_SCHEMA_VERSION) {
		throw new DrytisIntegrationError(`schemaVersion must be ${DRYTIS_INTEGRATION_SCHEMA_VERSION}.`, {
			code: 'unsupported_schema', status: 400
		});
	}
	const externalReviewId = canonicalUuid(value.externalReviewId);
	const project = normalizeDrytisProject(value.project, trustedProjectId);
	const projectContext = normalizeDrytisProjectContext(value.projectContext);
	const requestedChecks = normalizeDrytisRequestedChecks(value.requestedChecks);
	const previewUrl = normalizeHttpsTarget(value.previewUrl, false, 'previewUrl');
	const containerUrl = normalizeHttpsTarget(value.containerUrl, false, 'containerUrl');
	if (previewUrl && containerUrl && previewUrl !== containerUrl) {
		throw new DrytisIntegrationError('previewUrl and containerUrl must identify the same HTTPS target.', {
			code: 'invalid_preview_url', status: 400
		});
	}
	const targetUrl = containerUrl ?? previewUrl;
	if (requestedChecks.blackBox && !targetUrl) {
		throw new DrytisIntegrationError('containerUrl or previewUrl is required when black-box testing is requested.', {
			code: 'invalid_preview_url', status: 400
		});
	}
	if (!requestedChecks.blackBox && targetUrl !== undefined) {
		throw new DrytisIntegrationError('containerUrl and previewUrl are accepted only when black-box testing is requested.', {
			code: 'invalid_request', status: 400
		});
	}
	if (requestedChecks.whiteBox !== (value.sourceSnapshot !== undefined)) {
		throw new DrytisIntegrationError(
			requestedChecks.whiteBox
				? 'sourceSnapshot is required when white-box testing is requested.'
				: 'sourceSnapshot is accepted only when white-box testing is requested.',
			{ code: 'invalid_request', status: 400 }
		);
	}
	return {
		externalReviewId,
		project,
		projectContext,
		requestedChecks,
		containerUrl: targetUrl,
		// Kept as a normalized compatibility alias for the existing browser path.
		previewUrl: targetUrl,
		sourceSnapshot: value.sourceSnapshot
	};
}
