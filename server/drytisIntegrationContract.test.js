import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const openApiUrl = new URL('../docs/drytis-integration.openapi.yaml', import.meta.url);
const guideUrl = new URL('../docs/drytis-integration.md', import.meta.url);
const architectureUrl = new URL('../docs/drytis-studio-integration-architecture.md', import.meta.url);
const studioClientUrl = new URL('../integrations/drytis/qaseClient.js', import.meta.url);
const portableProtocolUrl = new URL('../integrations/drytis/protocol.js', import.meta.url);

test('Drytis OpenAPI stays aligned with the revision-bound bounded result contract', async () => {
	const yaml = await readFile(openApiUrl, 'utf8');
	assert.match(yaml, /Project:\r?\n[\s\S]*?required: \[id, name, revision\]/);
	assert.match(yaml, /insufficient_static_coverage/);
	assert.match(yaml, /filesWithoutLanguageRules/);
	assert.match(yaml, /findingsPage:/);
	assert.match(yaml, /repairTasksPage:/);
	assert.match(yaml, /maxItems: 40/);
	assert.match(yaml, /maxItems: 80/);
	assert.match(yaml, /snapshotSha256:/);
	assert.match(yaml, /containerUrl:/);
	assert.match(yaml, /ProjectContext:/);
	assert.match(yaml, /\/internal\/v1\/drytis\/reviews\/\{reviewId\}\/stop:/);

	const schemaNames = new Set([...yaml.matchAll(/^    ([A-Za-z][A-Za-z0-9]+):\r?$/gm)].map(match => match[1]));
	for (const match of yaml.matchAll(/#\/components\/schemas\/([A-Za-z][A-Za-z0-9]+)/g)) {
		assert.equal(schemaNames.has(match[1]), true, `missing OpenAPI schema ${match[1]}`);
	}
});

test('Drytis guide states the source, repair, polling, and external-platform boundaries', async () => {
	const guide = await readFile(guideUrl, 'utf8');
	assert.match(guide, /does \*\*not\*\* contain the Drytis application/);
	assert.match(guide, /revision-bound prompts are returned once/i);
	assert.match(guide, /At most 40 severity-prioritized findings/i);
	assert.match(guide, /There is no background outbox retry/i);
	assert.match(guide, /Drytis application implementation is absent here/i);
	assert.match(guide, /does \*\*not\*\* apply code changes to Drytis/);
});

test('Studio architecture guide keeps secrets server-side and preserves the approval boundary', async () => {
	const guide = await readFile(architectureUrl, 'utf8');
	assert.match(guide, /integrations\/drytis\/qaseClient\.js/);
	assert.match(guide, /browser must never call `\/internal\/v1\/drytis`/i);
	assert.match(guide, /human approval/i);
	assert.match(guide, /new immutable revision passes a\s+new QASE review/i);
});

test('Drytis adapter is portable and does not import Qase server internals', async () => {
	const [client, protocol] = await Promise.all([
		readFile(studioClientUrl, 'utf8'),
		readFile(portableProtocolUrl, 'utf8')
	]);
	assert.doesNotMatch(client, /\.\.\/\.\.\/server\//);
	assert.doesNotMatch(protocol, /\.\.\/\.\.\/server\//);
	assert.match(client, /from '\.\/protocol\.js'/);
});
