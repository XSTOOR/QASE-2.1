import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workloadUrl = new URL('../load/k6/control-plane-placement.js', import.meta.url);
const evidenceSchemaUrl = new URL('../deploy/qualification/capacity-evidence.schema.json', import.meta.url);
const resilienceSchemaUrl = new URL('../deploy/qualification/resilience-evidence.schema.json', import.meta.url);
const policyUrl = new URL('../deploy/qualification/capacity-policy.example.json', import.meta.url);

test('capacity workload is GET-only, allowlisted, acknowledged and bounded', async () => {
	const source = await readFile(workloadUrl, 'utf8');
	assert.match(source, /I_OWN_THIS_STAGING_TARGET/);
	assert.match(source, /QASE_CAPACITY_ALLOWED_HOSTS/);
	assert.match(source, /origin\.protocol !== 'https:'/);
	assert.match(source, /http\.get\(/);
	assert.doesNotMatch(source, /http\.(?:post|put|patch|del)\(/);
	assert.match(source, /Math\.min\(1_000, rate\(200\)\)/);
	assert.match(source, /rate<0\.001/);
	assert.doesNotMatch(source, /console\.(?:log|error)/);
});

test('qualification schemas and policy are strict, versioned and contain no secrets', async () => {
	const [evidenceSchema, resilienceSchema, policy] = await Promise.all([
		readFile(evidenceSchemaUrl, 'utf8').then(JSON.parse),
		readFile(resilienceSchemaUrl, 'utf8').then(JSON.parse),
		readFile(policyUrl, 'utf8').then(JSON.parse)
	]);
	assert.equal(evidenceSchema.additionalProperties, false);
	assert.equal(resilienceSchema.additionalProperties, false);
	assert.equal(policy.schemaVersion, 1);
	assert.equal(policy.workload, 'control-placement');
	assert.equal(resilienceSchema.properties.dataLossCount.const, 0);
	assert.equal(resilienceSchema.properties.crossTenantViolationCount.const, 0);
	assert.equal(resilienceSchema.properties.failedClosed.const, true);
	assert.doesNotMatch(JSON.stringify({ evidenceSchema, resilienceSchema, policy }), /password|authorization|bearer|apiKey/i);
});
