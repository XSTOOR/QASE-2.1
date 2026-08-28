import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('Drytis toolbar launch selects only a canonical visible run and removes the launch parameter', () => {
	const boot = app.slice(app.indexOf('/* ── Boot'), app.indexOf('})();', app.indexOf('/* ── Boot')) + 5);
	assert.match(boot, /new URLSearchParams\(window\.location\.search\)/);
	assert.match(boot, /launchParameters\.get\('run'\)/);
	assert.match(boot, /RUN_ID_PATTERN\.test\(requestedRunId\)/);
	assert.match(boot, /await selectSession\(requestedRunId\.toLowerCase\(\)\)/);
	assert.match(boot, /launchParameters\.delete\('run'\)/);
	assert.match(boot, /window\.history\.replaceState/);
	assert.match(boot, /stale or cross-project launch handle cannot select a run/);
});
