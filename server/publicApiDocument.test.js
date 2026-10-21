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

const OPERATIONS = [
	['/public/v1/health', 'health'],
	['/public/v1/runs', 'list_runs'],
	['/public/v1/runs/{id}', 'get_run'],
	['/public/v1/runs/{id}/findings', 'list_run_findings'],
	['/public/v1/runs/{id}/report.md', 'get_run_report']
];

function operationIds() {
	return Object.values(document.paths).flatMap(item =>
		Object.entries(item)
			.filter(([method]) => method === 'get')
			.map(([, op]) => op.operationId));
}

function walkSchemas(schemas, visit) {
	for (const [name, schema] of Object.entries(schemas ?? {})) {
		visit(name, schema);
		for (const part of schema.allOf ?? []) visit(`${name} (allOf)`, part);
	}
}

test('public OpenAPI document is valid JSON with exactly the implemented paths', () => {
	assert.equal(document.openapi, '3.0.3');
	assert.equal(document.info.title, 'Qase Public Read API');
	const paths = Object.keys(document.paths);
	assert.equal(paths.length, IMPLEMENTED_PATHS.size);
	for (const path of paths) {
		assert.ok(IMPLEMENTED_PATHS.has(path), `document path not implemented: ${path}`);
	}
	assert.deepEqual(document.servers, [{ url: 'https://qase.drytis.com' }]);
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
	assert.ok(document.components.securitySchemes.bearerAuth);
	assert.deepEqual(document.security, [{ bearerAuth: [] }]);
});

test('operationIds are unique snake_case ≤64 chars with summaries and tags', () => {
	const ids = operationIds();
	assert.equal(new Set(ids).size, ids.length, 'operationIds must be unique');
	assert.deepEqual([...ids].sort(), OPERATIONS.map(([, id]) => id).sort());
	for (const id of ids) {
		assert.ok(id.length <= 64, `${id} exceeds 64 chars`);
		assert.match(id, /^[a-z][a-z0-9_]*$/, `${id} must be snake_case`);
	}
	for (const [path] of OPERATIONS) {
		const op = document.paths[path].get;
		assert.equal(typeof op.summary, 'string', `${path} needs a summary`);
		assert.ok(op.tags.length >= 1, `${path} needs tags`);
	}
});

test('every GET declares a 200 response schema', () => {
	for (const [path] of OPERATIONS) {
		const responses = document.paths[path].get.responses['200'];
		assert.ok(responses, `${path} needs a 200 response`);
		const content = responses.content;
		assert.ok(content, `${path} 200 needs content`);
		for (const [mediaType, entry] of Object.entries(content)) {
			assert.ok(entry.schema, `${path} 200 ${mediaType} needs a schema`);
		}
	}
	assert.deepEqual(
		document.paths['/public/v1/runs/{id}/report.md'].get.responses['200'].content,
		{ 'text/markdown': { schema: { type: 'string' } } });
});

test('collections require data+total and declare paging with default and maximum', () => {
	const schemas = document.components.schemas;
	for (const name of ['RunList', 'FindingList']) {
		const schema = schemas[name];
		assert.deepEqual(schema.required, ['data', 'total'], `${name} must require data and total`);
		assert.equal(schema.properties.total.type, 'integer', `${name}.total must be integer`);
		assert.ok(schema.properties.data.items.$ref, `${name}.data items must be typed`);
		assert.ok(schema.properties.serverNow, `${name} must carry serverNow`);
	}
	const runParams = document.paths['/public/v1/runs'].get.parameters;
	const findingsParams = document.paths['/public/v1/runs/{id}/findings'].get.parameters;
	for (const [label, params] of [['runs', runParams], ['findings', findingsParams]]) {
		const page = params.find(p => p.name === 'page');
		const pageSize = params.find(p => p.name === 'page_size');
		assert.equal(page.schema.default, 1, `${label} page default`);
		assert.equal(page.schema.minimum, 1, `${label} page minimum`);
		assert.equal(pageSize.schema.default, 25, `${label} page_size default`);
		assert.equal(pageSize.schema.maximum, 100, `${label} page_size maximum`);
	}
});

test('filter enums match the implementation and dates are date-time', () => {
	const runParams = Object.fromEntries(
		document.paths['/public/v1/runs'].get.parameters.map(p => [p.name, p]));
	assert.deepEqual(runParams.status.schema.enum,
		['idle', 'running', 'done', 'error', 'interrupted', 'awaiting_input']);
	assert.deepEqual(runParams.mode.schema.enum, ['qa', 'sqa', 'founder']);
	assert.equal(runParams.device.schema.type, 'string');
	assert.equal(runParams.from.schema.format, 'date');
	assert.equal(runParams.to.schema.format, 'date');

	const findingsParams = Object.fromEntries(
		document.paths['/public/v1/runs/{id}/findings'].get.parameters.map(p => [p.name, p]));
	assert.deepEqual(findingsParams.severity.schema.enum,
		['critical', 'high', 'medium', 'low', 'info']);
	assert.deepEqual(findingsParams.status.schema.enum,
		['open', 'in_progress', 'fixed', 'wont_fix']);

	const RunSummary = document.components.schemas.RunSummary;
	for (const field of ['createdAt', 'updatedAt', 'startedAt', 'completedAt']) {
		assert.equal(RunSummary.properties[field].format, 'date-time', `RunSummary.${field} must be date-time`);
	}
	assert.equal(RunSummary.properties.status.enum.length, 6);
	assert.ok(RunSummary.properties.id.description, 'id needs a description');
	assert.ok(RunSummary.properties.title.description, 'title needs a description');
});
