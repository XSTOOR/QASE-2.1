import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	DEFAULT_ACTOR_EMAIL,
	DEFAULT_ACTOR_NAME,
	DEFAULT_ACTOR_USER_ID,
	DEFAULT_ORGANIZATION_ID,
	DEFAULT_ORGANIZATION_NAME,
	DEFAULT_ORGANIZATION_SLUG,
	DEFAULT_PROJECT_ID,
	DEFAULT_PROJECT_NAME,
	DEFAULT_PROJECT_SLUG,
	DEFAULT_TENANT_CONTEXT,
	TENANT_ENV_KEYS,
	createTenantContext
} from './tenancy.js';

const OVERRIDE_ORGANIZATION_ID = '3bbcee6b-1ed9-4f29-942b-0ed8e4207641';
const OVERRIDE_PROJECT_ID = 'ea850020-d13a-4df2-8b43-faf30d58b240';

test('per-instance defaults are deterministic, safe, and immutable', () => {
	const first = createTenantContext({});
	const second = createTenantContext({ PATH: 'ignored' });

	assert.deepEqual(first, DEFAULT_TENANT_CONTEXT);
	assert.deepEqual(second, DEFAULT_TENANT_CONTEXT);
	assert.deepEqual(first, {
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
	assert.equal(Object.isFrozen(DEFAULT_TENANT_CONTEXT), true);
	assert.equal(Object.isFrozen(first), true);
	assert.throws(() => {
		first.organizationId = OVERRIDE_ORGANIZATION_ID;
	}, TypeError);
	assert.equal(first.organizationId, DEFAULT_ORGANIZATION_ID);
});

test('trusted environment configuration can override the complete bootstrap identity', () => {
	const context = createTenantContext({
		[TENANT_ENV_KEYS.organizationId]: `  ${OVERRIDE_ORGANIZATION_ID.toUpperCase()}  `,
		[TENANT_ENV_KEYS.organizationSlug]: 'drytis-engineering',
		[TENANT_ENV_KEYS.organizationName]: '  Drytis Engineering  ',
		[TENANT_ENV_KEYS.projectId]: OVERRIDE_PROJECT_ID.toUpperCase(),
		[TENANT_ENV_KEYS.projectSlug]: 'qase-platform',
		[TENANT_ENV_KEYS.projectName]: '  Qase Platform  ',
		[TENANT_ENV_KEYS.actorUserId]: '7c661f9b-615f-4785-a935-ea89092d2da3',
		[TENANT_ENV_KEYS.actorEmail]: '  Owner@Drytis.example  ',
		[TENANT_ENV_KEYS.actorName]: '  Drytis Owner  '
	});

	assert.deepEqual(context, {
		organizationId: OVERRIDE_ORGANIZATION_ID,
		organizationSlug: 'drytis-engineering',
		organizationName: 'Drytis Engineering',
		projectId: OVERRIDE_PROJECT_ID,
		projectSlug: 'qase-platform',
		projectName: 'Qase Platform',
		actorUserId: '7c661f9b-615f-4785-a935-ea89092d2da3',
		actorEmail: 'owner@drytis.example',
		actorName: 'Drytis Owner',
		actorRole: 'owner'
	});
	assert.equal(Object.isFrozen(context), true);
});

test('organization and project ID overrides must be supplied as a matching pair', () => {
	assert.throws(
		() => createTenantContext({ [TENANT_ENV_KEYS.organizationId]: OVERRIDE_ORGANIZATION_ID }),
		/overrides must be configured together/i
	);
	assert.throws(
		() => createTenantContext({ [TENANT_ENV_KEYS.projectId]: OVERRIDE_PROJECT_ID }),
		/overrides must be configured together/i
	);
	assert.throws(
		() => createTenantContext({
			[TENANT_ENV_KEYS.organizationId]: OVERRIDE_ORGANIZATION_ID,
			[TENANT_ENV_KEYS.projectId]: OVERRIDE_ORGANIZATION_ID
		}),
		/must be different/i
	);
});

test('invalid or missing configured UUID values fail closed', () => {
	for (const invalid of ['', 'not-a-uuid', '00000000-0000-0000-0000-000000000000', 42, null]) {
		assert.throws(() => createTenantContext({
			[TENANT_ENV_KEYS.organizationId]: invalid,
			[TENANT_ENV_KEYS.projectId]: OVERRIDE_PROJECT_ID
		}), TypeError);
	}
});

test('unsafe slugs and display names are rejected', () => {
	for (const invalidSlug of ['', 'Uppercase', '-leading', 'trailing-', 'contains space', 'a'.repeat(64)]) {
		assert.throws(
			() => createTenantContext({ [TENANT_ENV_KEYS.organizationSlug]: invalidSlug }),
			TypeError
		);
	}

	for (const invalidName of ['', 'unsafe\nname', 'a'.repeat(121), 123]) {
		assert.throws(
			() => createTenantContext({ [TENANT_ENV_KEYS.projectName]: invalidName }),
			TypeError
		);
	}
});

test('request, body, and direct tenant fields are never accepted as trusted context', () => {
	const attacker = {
		organizationId: OVERRIDE_ORGANIZATION_ID,
		projectId: OVERRIDE_PROJECT_ID
	};
	for (const untrusted of [
		attacker,
		{ tenantId: OVERRIDE_ORGANIZATION_ID },
		{ body: attacker },
		{ query: attacker },
		{ headers: { 'x-tenant-id': OVERRIDE_ORGANIZATION_ID } },
		{ request: { body: attacker } }
	]) {
		assert.throws(() => createTenantContext(untrusted), /request-supplied tenant data/i);
	}
});

test('tenant context requires an environment-shaped object', () => {
	for (const invalid of [null, false, 'environment', [], 42]) {
		assert.throws(() => createTenantContext(invalid), /trusted environment object/i);
	}
});
