import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const agent = readFileSync(new URL('./agent.js', import.meta.url), 'utf8');
const store = readFileSync(new URL('./store.js', import.meta.url), 'utf8');

test('user Stop persists an authoritative resumable interrupted state', () => {
	assert.equal((agent.match(/setStatus\(session, 'interrupted', 'Stopped by user\.'\)/g) ?? []).length, 3);
	assert.doesNotMatch(agent, /setStatus\(session, 'idle', 'Stopped by user\.'\)/);
	assert.match(store, /session\.statusDetail = detail \|\| undefined/);
});

test('frontend labels only the confirmed user interruption as stopped', () => {
	assert.match(app, /status === 'interrupted' && state\.session\?\.statusDetail === 'Stopped by user\.'/);
	assert.match(app, /stoppedByUser \? 'Stopped'/);
	assert.match(app, /status === 'interrupted' \? 'Paused'/);
	assert.match(app, /session\.statusDetail = event\.detail \|\| undefined/);
});
