// #17934 — shared token accounting UI: chip text, pending/unavailable states,
// per-model attribution, dedupe on rollback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { usageChipText, tokenSummaryText, miniSummaryText } from './uiPrimitives.js';
import { applyUsage, subtractUsage } from '../server/usageCapture.js';

test('header chip renders real usage with in/out/total', () => {
	const usage = applyUsage(undefined, { model: 'z-ai/glm-5.2', inputTokens: 4_760_000, outputTokens: 27_200 });
	assert.equal(usage.estimated, false);
	const text = tokenSummaryText(usage);
	assert.match(text, /in/);
	assert.match(text, /out/);
	assert.match(text, /total/);
	assert.doesNotMatch(text, /~/, 'real reports carry no ~ marker');
});

test('estimated usage is marked with ~, never presented as authoritative', () => {
	const usage = applyUsage(undefined, { model: 'm', inputTokens: 5000, outputTokens: 100, estimated: true });
	assert.equal(usage.estimated, true);
	assert.match(tokenSummaryText(usage), /^~/);
});

test('no usage yet during a run is pending — never a fake zero', () => {
	const usage = undefined;
	assert.equal(tokenSummaryText(usage), undefined);
	// The UI contract: undefined summary + status running → 'awaiting usage report' state.
	const mini = miniSummaryText({ usage, status: 'running' });
	assert.match(mini.tokens, /--/, 'placeholder, not 0');
});

test('per-model attribution separates JEV from the primary model', () => {
	let usage;
	usage = applyUsage(usage, { model: 'z-ai/glm-5.2', inputTokens: 10_000, outputTokens: 2_000 });
	usage = applyUsage(usage, { model: 'z-ai/glm-5.2', inputTokens: 5_000, outputTokens: 500 });
	usage = applyUsage(usage, { model: 'drytis/jev-1.13', inputTokens: 800, outputTokens: 40 });
	assert.equal(usage.byModel['z-ai/glm-5.2'].inputTokens, 15_000);
	assert.equal(usage.byModel['drytis/jev-1.13'].inputTokens, 800);
	assert.equal(usage.totalTokens, 18_340);
});

test('retry/resume dedupe: a superseded estimate is rolled back exactly once', () => {
	let usage;
	// Estimate committed live for call A on model P...
	usage = applyUsage(usage, { model: 'P', inputTokens: 1_000, outputTokens: 100, estimated: true, callId: 'A' });
	// ...then the REAL report for the same call arrives.
	usage = subtractUsage(usage, { model: 'P', inputTokens: 1_000, outputTokens: 100 });
	usage = applyUsage(usage, { model: 'P', inputTokens: 1_200, outputTokens: 150, callId: 'A' });
	assert.equal(usage.inputTokens, 1_200, 'estimate replaced by the real report, not added on top');
	assert.equal(usage.byModel.P.inputTokens, 1_200);
	assert.equal(usage.totalTokens, 1_350);
});

test('usageChipText composes a compact chip with context percentage', () => {
	const usage = { inputTokens: 4_760_000, outputTokens: 27_200, totalTokens: 4_787_200, estimated: false };
	assert.equal(usageChipText(usage, { percentage: 42 }).endsWith('42% ctx'), true);
	assert.equal(usageChipText(undefined), undefined);
});
