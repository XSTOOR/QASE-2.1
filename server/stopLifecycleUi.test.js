import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const engines = ['qa', 'sqa', 'founder'].map(mode => [mode, readFileSync(new URL(`./${mode}/engine.js`, import.meta.url), 'utf8')]);
const store = readFileSync(new URL('./store.js', import.meta.url), 'utf8');

test('a user Stop marks unfinished stages and still publishes the work done so far', () => {
	for (const [mode, source] of engines) {
		assert.match(source, /status: 'skipped', detail: 'Stopped by user'/, `${mode} records stopped stages`);
		assert.match(source, /if \(stopped\(\) && session\.status === 'awaiting_input'\) await runStore\.setStatus\(session, 'running'/, `${mode} leaves a pending question before publishing`);
		assert.doesNotMatch(source, /setStatus\(session, 'idle', 'Stopped by user\.'\)/);
	}
	assert.match(store, /session\.statusDetail = detail \|\| undefined/);
});

test('frontend labels only the confirmed user interruption as stopped', () => {
	assert.match(app, /status === 'interrupted' && state\.session\?\.statusDetail === 'Stopped by user\.'/);
	assert.match(app, /stoppedByUser \? 'Stopped'/);
	assert.match(app, /status === 'interrupted' \? 'Paused'/);
	assert.match(app, /session\.statusDetail = event\.detail \|\| undefined/);
});
