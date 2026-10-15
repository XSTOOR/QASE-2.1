import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { escapeHtml, formatTokens, hostOf, markdown, relativeTime, tokenSummaryText, truncate, usageChipText, miniSummaryText } from '../public/uiPrimitives.js';

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

test('token count formatting keeps compact thresholds and trims trailing zeros', () => {
	assert.equal(formatTokens(0), undefined);
	assert.equal(formatTokens(-5), undefined);
	assert.equal(formatTokens(Number.NaN), undefined);
	assert.equal(formatTokens(820), '820');
	assert.equal(formatTokens(999), '999');
	assert.equal(formatTokens(1_000), '1k');
	assert.equal(formatTokens(15_340), '15.3k');
	assert.equal(formatTokens(120_000), '120k');
	assert.equal(formatTokens(4_760_000), '4.76M');
	assert.equal(formatTokens(3_400_000_000), '3.4B');
});

test('usage chip attaches the tok unit to each count segment, never standalone', () => {
	// Screenshot scenario: 4.76M in · 27.2k out · tok · 88% ctx was the bug.
	const usage = { inputTokens: 4_760_000, outputTokens: 27_200, totalTokens: 4_787_200 };
	const chip = usageChipText(usage, { percentage: 88.4 });
	assert.equal(chip, '4.76M tok in · 27.2k tok out · 88% ctx');
	assert.doesNotMatch(chip, / · tok/);

	assert.equal(usageChipText({ inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200 }), '1k tok in · 200 tok out');
	assert.equal(usageChipText({ inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200, estimated: true }, { percentage: 12 }), '~1k tok in · ~200 tok out · 12% ctx');
	// Output-only usage renders a single segment; no usage renders nothing.
	assert.equal(usageChipText({ outputTokens: 50, totalTokens: 50 }), '50 tok out');
	assert.equal(usageChipText(undefined), undefined);
	assert.equal(usageChipText({ totalTokens: 0 }), undefined);
	assert.equal(usageChipText({ totalTokens: 500 }, { percentage: 40 }), undefined, 'total > 0 but no formattable counts');
});

test('token summary row composes in/out/total without ctx and marks estimates', () => {
	const usage = { inputTokens: 4_760_000, outputTokens: 27_200, totalTokens: 4_787_200 };
	assert.equal(tokenSummaryText(usage), '4.76M in · 27.2k out · 4.79M total');
	assert.equal(tokenSummaryText({ inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200 }), '1k in · 200 out · 1.2k total');
	assert.equal(tokenSummaryText({ inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200, estimated: true }), '~1k in · ~200 out · ~1.2k total');
	assert.equal(tokenSummaryText({ outputTokens: 50, totalTokens: 50 }), '50 out · 50 total');
	// No ctx % in the row — it rides the tooltip; no usage → nothing to render.
	assert.doesNotMatch(tokenSummaryText({ inputTokens: 100, outputTokens: 100, totalTokens: 200 }) ?? '', /ctx/);
	assert.equal(tokenSummaryText(undefined), undefined);
	assert.equal(tokenSummaryText({ totalTokens: 0 }), undefined);
	assert.equal(tokenSummaryText({ inputTokens: 0, outputTokens: 0, totalTokens: 500 }), undefined, 'total > 0 but no formattable counts');
});

test('mini summary composes the compact collapsed row segments', () => {
	// Done run with full data — matches the requested shape: ✦ 6.39M tokens · ● DONE · 5/5 · 100% · Findings 4
	const done = miniSummaryText({
		usage: { inputTokens: 6_350_000, outputTokens: 31_600, totalTokens: 6_381_600 },
		status: 'done',
		progress: { total: 5, done: 5, percent: 100 },
		findings: 4,
	});
	assert.equal(done.tokens, '✦ 6.38M tokens');
	assert.equal(done.status, '● DONE');
	assert.equal(done.progress, '5/5 · 100%');
	assert.equal(done.findings, 'Findings 4');

	// Running run, mid-flight — live values keep flowing into the mini row.
	const running = miniSummaryText({
		usage: { inputTokens: 4_790_000, outputTokens: 30_000, totalTokens: 4_820_000 },
		status: 'running',
		progress: { total: 16, done: 13, percent: 81 },
		findings: 12,
	});
	assert.equal(running.tokens, '✦ 4.82M tokens');	assert.equal(running.status, '● RUNNING');
	assert.equal(running.progress, '13/16 · 81%');
	assert.equal(running.findings, 'Findings 12');

	// Estimates carry the ~ marker; pending usage shows -- instead of 0.
	const est = miniSummaryText({
		usage: { inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200, estimated: true },
		status: 'running',
		progress: { total: 8, done: 3, percent: 38 },
		findings: 0,
	});
	assert.equal(est.tokens, '✦ ~1.2k tokens');
	assert.equal(est.findings, '');

	const pending = miniSummaryText({
		usage: undefined,
		status: 'running',
		progress: { total: 0, done: 0, percent: undefined },
		findings: 0,
	});
	assert.equal(pending.tokens, '✦ -- tokens');
	assert.equal(pending.status, '● RUNNING');
	assert.equal(pending.progress, '');

	// Status mapping: awaiting_input humanized, unknown passthrough, missing → undefined.
	assert.equal(miniSummaryText({ usage: undefined, status: 'awaiting_input', progress: undefined, findings: 0 }).status, '● waiting for you');
	assert.equal(miniSummaryText({ usage: undefined, status: 'queued', progress: undefined, findings: 0 }).status, '● QUEUED');
	assert.equal(miniSummaryText({ usage: undefined, status: undefined, progress: undefined, findings: 0 }).status, '');

	// No usage but a countable total still shows the total.
	const onlyTotal = miniSummaryText({ usage: { totalTokens: 500 }, status: 'done', progress: { total: 2, done: 0, percent: 0 }, findings: 1 });
	assert.equal(onlyTotal.tokens, '✦ -- tokens', 'unformattable counts are pending-style, never fake 0');
	assert.equal(onlyTotal.progress, '0/2 · 0%');
});

test('the application controller consumes extracted UI modules instead of redefining them', () => {	assert.match(app, /from '\.\/uiPrimitives\.js'/);
	assert.match(app, /from '\.\/founderView\.js'/);
	assert.match(app, /createFounderView\(\{/);
	for (const name of ['escapeHtml', 'markdown', 'hostOf', 'relativeTime', 'truncate', 'section', 'paragraph', 'list', 'formatTokens', 'usageChipText', 'tokenSummaryText']) {
		assert.doesNotMatch(app, new RegExp(`function ${name}\\(`));
	}
});
