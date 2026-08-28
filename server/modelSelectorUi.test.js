import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('settings exposes an endpoint-backed model selector with a custom fallback', () => {
	assert.match(html, /<select id="cfg-model"[^>]*>/);
	assert.match(html, /<input id="cfg-model-custom"[^>]*hidden/);
	assert.doesNotMatch(html, /<datalist id="cfg-model-list"/);
	assert.match(app, /function fillModelOptions\(models = \[\], selected = ''\)/);
	assert.match(app, /Custom model ID…/);
	assert.match(app, /result\.models \?\? \[\]/);
});

test('settings auto-loads models and saves the selected or custom model id', () => {
	assert.match(app, /if \(config\.ready\) void probeModelEndpoint\(\{ announce: false \}\)/);
	assert.match(app, /model: selectedModelId\(\)/);
	assert.match(app, /cfg\.model\.value === CUSTOM_MODEL_VALUE \? cfg\.modelCustom\.value : cfg\.model\.value/);
});
