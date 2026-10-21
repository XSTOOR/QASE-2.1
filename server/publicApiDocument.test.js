import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const document = JSON.parse(readFileSync(new URL('../public/public-api-openapi.json', import.meta.url), 'utf8'));

const IMPLEMENTED_PATHS = new Set([
	'/public/v1/health',
	'/public/v1/runs',
	'/public/v1/runs/{id}',
	'/public/v1/runs/{id}/findings',
	'/public/v1/runs/{id}/report.md'
]);

test('public OpenAPI document is valid JSON with exactly the implemented paths', () => {
	assert.equal(document.openapi, '3.1.0');
	assert.equal(document.info.title, 'Qase Public Read API');
	const paths = Object.keys(document.paths);
	assert.equal(paths.length, IMPLEMENTED_PATHS.size);
	for (const path of paths) {
		assert.ok(IMPLEMENTED_PATHS.has(path), `document path not implemented: ${path}`);
	}
});

test('every public operation is GET-only and auth matches the routes', () => {
	for (const [path, item] of Object.entries(document.paths)) {
		for (const method of Object.keys(item)) {
			if (method === 'parameters') continue;
			assert.equal(method, 'get', `${path} must be GET-only`);
		}
	}
	// Health is the only unauthenticated route; the rest carry bearerAuth.
	assert.deepEqual(document.paths['/public/v1/health'].get.security, []);
	assert.equal(document.securitySchemesRef ?? undefined, undefined);
	assert.ok(document.components.securitySchemes.bearerAuth);
	assert.deepEqual(document.security, [{ bearerAuth: [] }]);
});
