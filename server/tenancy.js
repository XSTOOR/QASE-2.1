/**
 * Trusted tenant identity for one Drytis-owned Qase instance.
 *
 * Phase 2 will persist every run beneath an organization and project. Until
 * Drytis identity is introduced, those identifiers come only from process
 * configuration. Request bodies, query strings and headers are deliberately
 * not accepted by this module.
 */

export const DEFAULT_ORGANIZATION_ID = '4a7f5cf0-813d-4e3c-8d5d-4b4b9fc88c01';
export const DEFAULT_PROJECT_ID = '4a7f5cf0-813d-4e3c-8d5d-4b4b9fc88c02';
export const DEFAULT_ACTOR_USER_ID = '4a7f5cf0-813d-4e3c-8d5d-4b4b9fc88c03';
export const DEFAULT_ORGANIZATION_SLUG = 'qase-local';
export const DEFAULT_ORGANIZATION_NAME = 'Qase Local';
export const DEFAULT_PROJECT_SLUG = 'default-project';
export const DEFAULT_PROJECT_NAME = 'Default Project';
export const DEFAULT_ACTOR_EMAIL = 'owner@local.qase.invalid';
export const DEFAULT_ACTOR_NAME = 'Qase Local Owner';

export const TENANT_ENV_KEYS = Object.freeze({
	organizationId: 'QASE_BOOTSTRAP_ORGANIZATION_ID',
	organizationSlug: 'QASE_BOOTSTRAP_ORGANIZATION_SLUG',
	organizationName: 'QASE_BOOTSTRAP_ORGANIZATION_NAME',
	projectId: 'QASE_BOOTSTRAP_PROJECT_ID',
	projectSlug: 'QASE_BOOTSTRAP_PROJECT_SLUG',
	projectName: 'QASE_BOOTSTRAP_PROJECT_NAME',
	actorUserId: 'QASE_BOOTSTRAP_USER_ID',
	actorEmail: 'QASE_BOOTSTRAP_USER_EMAIL',
	actorName: 'QASE_BOOTSTRAP_USER_NAME'
});

export const DEFAULT_TENANT_CONTEXT = Object.freeze({
	organizationId: DEFAULT_ORGANIZATION_ID,
	organizationSlug: DEFAULT_ORGANIZATION_SLUG,
	organizationName: DEFAULT_ORGANIZATION_NAME,
	projectId: DEFAULT_PROJECT_ID,
	projectSlug: DEFAULT_PROJECT_SLUG,
	projectName: DEFAULT_PROJECT_NAME,
	actorUserId: DEFAULT_ACTOR_USER_ID,
	actorEmail: DEFAULT_ACTOR_EMAIL,
	actorName: DEFAULT_ACTOR_NAME,
	actorRole: 'owner'
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNTRUSTED_CONTEXT_KEYS = new Set([
	'actorId', 'body', 'headers', 'organizationId', 'params', 'projectId', 'query',
	'request', 'tenant', 'tenantId', 'userId'
]);

function requireEnvironment(environment) {
	if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
		throw new TypeError('Tenant context requires a trusted environment object.');
	}
	for (const key of UNTRUSTED_CONTEXT_KEYS) {
		if (Object.hasOwn(environment, key)) {
			throw new TypeError('Tenant context cannot be created from request-supplied tenant data.');
		}
	}
	return environment;
}

function configuredValue(environment, key) {
	if (!Object.hasOwn(environment, key)) {
		return undefined;
	}
	const value = environment[key];
	if (typeof value !== 'string' || value.trim() === '') {
		throw new TypeError(`${key} must be a non-empty string when configured.`);
	}
	return value.trim();
}

function uuid(value, key) {
	if (!UUID_PATTERN.test(value)) {
		throw new TypeError(`${key} must be a canonical RFC UUID.`);
	}
	return value.toLowerCase();
}

function slug(value, key) {
	if (!SLUG_PATTERN.test(value)) {
		throw new TypeError(`${key} must be a lowercase DNS-safe slug of at most 63 characters.`);
	}
	return value;
}

function displayName(value, key) {
	if (value.length > 120 || CONTROL_CHARACTER_PATTERN.test(value)) {
		throw new TypeError(`${key} must be a safe display name of at most 120 characters.`);
	}
	return value;
}

function email(value, key) {
	const normalized = value.toLowerCase();
	if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
		throw new TypeError(`${key} must be a valid email address.`);
	}
	return normalized;
}

/**
 * Creates the immutable tenant context used by the per-instance access adapter.
 * IDs may be overridden only as a pair so a configured organization is never
 * accidentally combined with the deterministic default project (or vice versa).
 */
export function createTenantContext(environment = process.env) {
	const trusted = requireEnvironment(environment);
	const organizationIdOverride = configuredValue(trusted, TENANT_ENV_KEYS.organizationId);
	const projectIdOverride = configuredValue(trusted, TENANT_ENV_KEYS.projectId);
	if (Boolean(organizationIdOverride) !== Boolean(projectIdOverride)) {
		throw new TypeError('Organization and project ID overrides must be configured together.');
	}

	const organizationId = uuid(
		organizationIdOverride ?? DEFAULT_ORGANIZATION_ID,
		TENANT_ENV_KEYS.organizationId
	);
	const projectId = uuid(
		projectIdOverride ?? DEFAULT_PROJECT_ID,
		TENANT_ENV_KEYS.projectId
	);
	const actorUserId = uuid(
		configuredValue(trusted, TENANT_ENV_KEYS.actorUserId) ?? DEFAULT_ACTOR_USER_ID,
		TENANT_ENV_KEYS.actorUserId
	);
	if (new Set([organizationId, projectId, actorUserId]).size !== 3) {
		throw new TypeError('Organization, project, and actor user IDs must be different.');
	}

	const organizationSlugValue = configuredValue(trusted, TENANT_ENV_KEYS.organizationSlug)
		?? DEFAULT_ORGANIZATION_SLUG;
	const organizationNameValue = configuredValue(trusted, TENANT_ENV_KEYS.organizationName)
		?? DEFAULT_ORGANIZATION_NAME;
	const projectSlugValue = configuredValue(trusted, TENANT_ENV_KEYS.projectSlug)
		?? DEFAULT_PROJECT_SLUG;
	const projectNameValue = configuredValue(trusted, TENANT_ENV_KEYS.projectName)
		?? DEFAULT_PROJECT_NAME;
	const actorEmailValue = configuredValue(trusted, TENANT_ENV_KEYS.actorEmail)
		?? DEFAULT_ACTOR_EMAIL;
	const actorNameValue = configuredValue(trusted, TENANT_ENV_KEYS.actorName)
		?? DEFAULT_ACTOR_NAME;

	return Object.freeze({
		organizationId,
		organizationSlug: slug(organizationSlugValue, TENANT_ENV_KEYS.organizationSlug),
		organizationName: displayName(organizationNameValue, TENANT_ENV_KEYS.organizationName),
		projectId,
		projectSlug: slug(projectSlugValue, TENANT_ENV_KEYS.projectSlug),
		projectName: displayName(projectNameValue, TENANT_ENV_KEYS.projectName),
		actorUserId,
		actorEmail: email(actorEmailValue, TENANT_ENV_KEYS.actorEmail),
		actorName: displayName(actorNameValue, TENANT_ENV_KEYS.actorName),
		actorRole: 'owner'
	});
}
