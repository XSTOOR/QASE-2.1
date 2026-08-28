import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { escapeHtml, hostOf, markdown, relativeTime, truncate } from '../public/uiPrimitives.js';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('dashboard text primitives preserve the existing safe markdown contract', () => {
	assert.equal(escapeHtml('<script>&"\''), '&lt;script&gt;&amp;&quot;&#39;');
	const rendered = markdown([
		'# Result',
		'',
		'**Strong** and `code` with <img src=x onerror=alert(1)>.',
		'',
		'- first',
		'- second',
		'',
		'[safe](https://example.com) [unsafe](javascript:alert(1))'
	].join('\n'));
	assert.match(rendered, /<h3>Result<\/h3>/);
	assert.match(rendered, /<strong>Strong<\/strong>/);
	assert.match(rendered, /<ul><li>first<\/li><li>second<\/li><\/ul>/);
	assert.match(rendered, /href="https:\/\/example\.com"[^>]+rel="noreferrer noopener"/);
	assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
	assert.doesNotMatch(rendered, /<img|href="javascript:/);
});

test('dashboard formatting primitives keep host, truncation, and relative-time behavior stable', () => {
	assert.equal(hostOf('https://studio.drytis.ai/chat?id=1'), 'studio.drytis.ai');
	assert.equal(hostOf('not a URL'), 'not a URL');
	assert.equal(truncate('123456', 5), '1234…');
	assert.equal(truncate('1234', 5), '1234');
	const now = Date.UTC(2026, 7, 26, 12, 0, 0);
	assert.equal(relativeTime(now - 20_000, now), 'just now');
	assert.equal(relativeTime(now - 5 * 60_000, now), '5m ago');
	assert.equal(relativeTime(now - 3 * 3_600_000, now), '3h ago');
});

test('the application controller consumes extracted UI modules instead of redefining them', () => {
	assert.match(app, /from '\.\/uiPrimitives\.js'/);
	assert.match(app, /from '\.\/founderView\.js'/);
	assert.match(app, /createFounderView\(\{/);
	for (const name of ['escapeHtml', 'markdown', 'hostOf', 'relativeTime', 'truncate', 'section', 'paragraph', 'list']) {
		assert.doesNotMatch(app, new RegExp(`function ${name}\\(`));
	}
});
