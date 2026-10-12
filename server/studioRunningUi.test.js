import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('running summary restores an authoritative activity after reconnect', () => {
	const block = app.slice(app.indexOf('function renderCurrentActivity()'), app.indexOf('function setStatus('));
	assert.match(block, /session\.activities/);
	assert.match(block, /activity\.status === 'running'/);
	assert.match(block, /session\.todos/);
	assert.match(block, /todo\.status === 'in_progress'/);
	assert.match(block, /action \|\| \(text \? tailOf\(text\) : ''\) \|\| savedAction/);
});
