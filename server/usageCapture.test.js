import assert from 'node:assert/strict';
import test from 'node:test';
import {
	applyUsage,
	attachUsageCapture,
	createUsageLogger,
	parseAzureUsageLine,
	parseStageCompleteLine,
	sumUsage
} from './usageCapture.js';

test('parseAzureUsageLine extracts reported token counts', () => {
	assert.deepEqual(
		parseAzureUsageLine('[CleanSlateAzureDebug] provider=Azure OpenAI model=gpt-4o reportedInputTokens=1500 reportedOutputTokens=300 reportedTotalTokens=1800 cachedInputTokens=200'),
		{ inputTokens: 1500, outputTokens: 300, totalTokens: 1800, cachedInputTokens: 200 }
	);
	assert.deepEqual(
		parseAzureUsageLine('[CleanSlateAzureDebug] provider=Azure AI Foundry model=glm-4 reportedInputTokens=unknown reportedOutputTokens=12 reportedTotalTokens=unknown'),
		{ inputTokens: undefined, outputTokens: 12, totalTokens: undefined, cachedInputTokens: undefined }
	);
	assert.equal(parseAzureUsageLine('[CleanSlateAzureDebug] provider=Azure OpenAI unrelated message'), undefined);
	assert.equal(parseAzureUsageLine('anything else entirely'), undefined);
});

test('parseStageCompleteLine extracts estimate fields only for stage=complete', () => {
	assert.deepEqual(
		parseStageCompleteLine('[CleanSlateService] provider=OpenAI model=gpt-4o stage=complete elapsedMs=4200 inputChars=9000 estimatedInputTokens=2250 outputChars=2800 estimatedOutputTokens=700'),
		{ inputTokens: 2250, outputTokens: 700, estimated: true }
	);
	assert.equal(parseStageCompleteLine('[CleanSlateService] provider=OpenAI stage=first-part estimatedInputTokens=100'), undefined);
	assert.equal(parseStageCompleteLine('noise'), undefined);
});

test('sumUsage adds components and recomputes totals', () => {
	assert.deepEqual(
		sumUsage([
			{ inputTokens: 100, outputTokens: 40, totalTokens: 140, cachedInputTokens: 10 },
			{ inputTokens: 5, outputTokens: 5 }
		]),
		{ inputTokens: 105, outputTokens: 45, cachedInputTokens: 10, totalTokens: 150 }
	);
	assert.equal(sumUsage([]), undefined);
});

test('applyUsage accumulates per-run totals, keeps the last known total, and marks estimates', () => {
	const base = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
	let usage = applyUsage(base, { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 });
	const { byModel: _byModel, ...usageFlat } = usage;
	assert.deepEqual(usageFlat, { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cachedInputTokens: 0, estimated: false, updatedAt: usage.updatedAt });
	usage = applyUsage(usage, { inputTokens: 500, outputTokens: 100, totalTokens: 600, cachedInputTokens: 50 });
	assert.equal(usage.inputTokens, 1500);
	assert.equal(usage.outputTokens, 300);
	assert.equal(usage.totalTokens, 1800);
	assert.equal(usage.cachedInputTokens, 50);
	assert.equal(usage.estimated, false);
	// A subsequent call without a provider receipt is still counted.
	usage = applyUsage(usage, { inputTokens: 5, outputTokens: 5, estimated: true });
	assert.equal(usage.inputTokens, 1505);
	assert.equal(usage.estimated, true);
	assert.equal(applyUsage(usage, { inputTokens: 3, outputTokens: 2 }).estimated, true);
	// A pure-estimate run is marked as such.
	const estimate = applyUsage(base, { inputTokens: 5, outputTokens: 5, estimated: true });
	assert.equal(estimate.estimated, true);
	assert.equal(estimate.totalTokens, 10);
});

// #17934 — shared token accounting: per-model breakdown.
test('mixed receipts stay attributed and their sum agrees with the aggregate', () => {
	const base = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
	let usage = applyUsage(base, { model: 'z-ai/glm-5.2', inputTokens: 1000, outputTokens: 200, estimated: true });
	usage = applyUsage(usage, { model: 'drytis/jev-1.13', inputTokens: 10, outputTokens: 5 });
	usage = applyUsage(usage, { model: 'z-ai/glm-5.2', inputTokens: 300, outputTokens: 50, estimated: true });
	assert.equal(usage.byModel['z-ai/glm-5.2'].inputTokens, 1300);
	assert.equal(usage.byModel['z-ai/glm-5.2'].outputTokens, 250);
	assert.equal(usage.byModel['drytis/jev-1.13'].inputTokens, 10);
	assert.equal(usage.totalTokens, 1565);
	assert.equal(usage.estimated, true);
});

test('resuming legacy aggregates preserves their totals without carrying stale model attribution', () => {
	for (const byModel of [undefined, { old: { inputTokens: 800, outputTokens: 100 } }]) {
		const legacy = { inputTokens: 80, outputTokens: 10, byModel };
		const usage = applyUsage(legacy, { model: 'primary', inputTokens: 5, outputTokens: 1 });
		assert.deepEqual(usage.byModel, {
			unknown: { inputTokens: 80, outputTokens: 10 },
			primary: { inputTokens: 5, outputTokens: 1 }
		});
		assert.equal(usage.totalTokens, 96);
	}
});

test('SDK streams choose one receipt each, including interleaved streams using the same model', () => {
	const captured = [];
	const service = { logProviderReportedUsage() {}, logProviderTiming() {} };
	const release = attachUsageCapture(service, { estimateMissing: true, onUsage: usage => captured.push(usage) });
	const first = { model: 'primary', estimatedInputTokens: 1000 };
	const second = { model: 'primary', estimatedInputTokens: 1300 };
	const partial = { model: 'primary', estimatedInputTokens: 1500 };
	service.logProviderTiming('first-part', first, 0, 1);
	service.logProviderReportedUsage(first, { inputTokens: 700, outputTokens: 10 });
	service.logProviderTiming('complete', second, 0, 2, 7, 9);
	service.logProviderReportedUsage(first, { outputTokens: 42, cachedInputTokens: 50 });
	service.logProviderTiming('complete', first, 0, 3, 400);
	service.logProviderTiming('complete', first, 0, 3, 400);
	service.logProviderReportedUsage(partial, { inputTokens: 1200 });
	service.logProviderTiming('complete', partial, 0, 2, 28);
	release();
	service.logProviderTiming('complete', { model: 'primary', estimatedInputTokens: 500 }, 0, 2, 60);
	assert.deepEqual(captured.map(({ model, inputTokens, outputTokens, estimated, cachedInputTokens }) =>
		[model, inputTokens, outputTokens, estimated, cachedInputTokens]), [
		['primary', 1300, 4, true, undefined],
		['primary', 700, 42, false, 50],
		['primary', 1200, 7, true, undefined]
	]);
});

test('attachUsageCapture wraps logProviderReportedUsage and harvests every provider call', () => {
	const captured = [];
	const service = {
		logProviderReportedUsage(_diagnostics, usage) { captured.push(['original', usage]); },
		logger: { info() {}, debug() {}, error() {} }
	};
	const release = attachUsageCapture(service, { onUsage: usage => captured.push(['captured', usage]) });

	service.logProviderReportedUsage({ providerName: 'OpenAI' }, { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 1 });
	service.logProviderReportedUsage({ providerName: 'Anthropic' }, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });

	assert.deepEqual(captured, [
		['captured', { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 1 }],
		['original', { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 1 }],
		['captured', { inputTokens: 7, outputTokens: 3, totalTokens: 10 }],
		['original', { inputTokens: 7, outputTokens: 3, totalTokens: 10 }]
	]);
	release();
	service.logProviderReportedUsage({ providerName: 'OpenAI' }, { inputTokens: 99, outputTokens: 9, totalTokens: 108 });
	assert.deepEqual(captured.at(-1), ['original', { inputTokens: 99, outputTokens: 9, totalTokens: 108 }], 'released wrapper no longer captures');
	assert.equal(captured.length, 5);
});

test('a report captured by the wrapper is not double-counted when the SDK also logs it', () => {
	// Azure flow: the wrapper harvests the usage, then the SDK original logs
	// the same report as a [CleanSlateAzureDebug] info line — through the same
	// injected logger. The logger must not harvest that line again.
	const reports = [];
	const estimates = [];
	const service = {
		logProviderReportedUsage(diagnostics, usage) {
			this.logger.info(`[CleanSlateAzureDebug] provider=${diagnostics.providerName} model=m reportedInputTokens=${usage.inputTokens} reportedOutputTokens=${usage.outputTokens} reportedTotalTokens=${usage.totalTokens} cachedInputTokens=${usage.cachedInputTokens ?? 0}`);
		},
		logger: createUsageLogger({ onUsage: usage => reports.push(usage), onEstimate: usage => estimates.push(usage) })
	};
	const release = attachUsageCapture(service, { onUsage: usage => reports.push(usage) });
	service.logProviderReportedUsage({ providerName: 'Azure OpenAI' }, { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 0 });
	release();

	assert.deepEqual(reports, [{ inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 0 }]);
	assert.deepEqual(estimates, []);
});

test('attachUsageCapture no-ops safely on missing internals', () => {
	const release = attachUsageCapture(undefined, { onUsage: () => assert.fail('must not be called') });
	assert.equal(typeof release, 'function');
	release();
	const release2 = attachUsageCapture({}, { onUsage: () => assert.fail('must not be called') });
	release2();
});

test('createUsageLogger harvests estimate lines only — Azure usage lines are the wrapper\'s job', () => {
	const real = [];
	const estimated = [];
	const logger = createUsageLogger({
		onUsage: usage => real.push(usage),
		onEstimate: usage => estimated.push(usage)
	});
	logger.info('[CleanSlateAzureDebug] provider=Azure OpenAI model=gpt-4o reportedInputTokens=1500 reportedOutputTokens=300 reportedTotalTokens=1800 cachedInputTokens=200');
	logger.debug('[CleanSlateService] provider=Custom API model=m stage=complete elapsedMs=1 inputChars=4000 estimatedInputTokens=1000 outputChars=800 estimatedOutputTokens=200');
	logger.debug('[CleanSlateService] provider=Custom API model=m stage=first-part estimatedInputTokens=5');
	logger.info('unrelated');
	logger.error('unrelated');

	assert.deepEqual(real, [], 'Azure usage lines are NOT harvested here (attachUsageCapture covers them)');
	assert.deepEqual(estimated, [{ inputTokens: 1000, outputTokens: 200, estimated: true }]);
});

// ── Empty-output runaway guard (#16225 follow-up) ─────────────────────────

import { createEmptyOutputGuard } from './usageCapture.js';

test('empty-output guard: fires after N consecutive empty REAL reports', () => {
	const breaches = [];
	const guard = createEmptyOutputGuard({ limit: 3, onBreach: report => breaches.push(report) });
	guard.observe({ inputTokens: 500, outputTokens: 0 });
	assert.equal(breaches.length, 0);
	guard.observe({ inputTokens: 500, outputTokens: 0 });
	assert.equal(breaches.length, 0);
	guard.observe({ inputTokens: 500, outputTokens: 0 });
	assert.equal(breaches.length, 1, 'third consecutive empty report breaches');
});

test('empty-output guard: a non-empty report resets the streak', () => {
	const breaches = [];
	const guard = createEmptyOutputGuard({ limit: 2, onBreach: r => breaches.push(r) });
	guard.observe({ inputTokens: 500, outputTokens: 0 });
	guard.observe({ inputTokens: 500, outputTokens: 40 });
	guard.observe({ inputTokens: 500, outputTokens: 0 });
	assert.equal(breaches.length, 0, 'streak was reset by the non-empty report');
	guard.observe({ inputTokens: 500, outputTokens: 0 });
	assert.equal(breaches.length, 1);
});

test('empty-output guard: estimates never trigger', () => {
	const breaches = [];
	const guard = createEmptyOutputGuard({ limit: 2, onBreach: r => breaches.push(r) });
	guard.observe({ inputTokens: 500, outputTokens: 0, estimated: true });
	guard.observe({ inputTokens: 500, outputTokens: 0, estimated: true });
	guard.observe({ inputTokens: 500, outputTokens: 0, estimated: true });
	assert.equal(breaches.length, 0, 'estimated reports are not model truth');
});

test('empty-output guard: inputTokens=0 reports are ignored entirely', () => {
	const breaches = [];
	const guard = createEmptyOutputGuard({ limit: 2, onBreach: r => breaches.push(r) });
	guard.observe({ inputTokens: 0, outputTokens: 0 });
	guard.observe({ inputTokens: 0, outputTokens: 0 });
	assert.equal(breaches.length, 0);
	assert.equal(guard.emptyStreak(), 0, 'non-completion reports do not count toward the streak');
});

test('empty-output guard: keeps firing on further empties (abort is idempotent)', () => {
	const breaches = [];
	const guard = createEmptyOutputGuard({ limit: 1, onBreach: r => breaches.push(r) });
	guard.observe({ inputTokens: 500, outputTokens: 0 });
	guard.observe({ inputTokens: 500, outputTokens: 0 });
	guard.observe({ inputTokens: 500, outputTokens: 0 });
	assert.equal(breaches.length, 3, 'each empty report past the limit re-fires');
});

test('empty-output guard: limit is clamped to at least 1', () => {
	const breaches = [];
	const guard = createEmptyOutputGuard({ limit: 0, onBreach: r => breaches.push(r) });
	guard.observe({ inputTokens: 500, outputTokens: 0 });
	assert.equal(breaches.length, 1, 'degenerate limit still trips on the first empty report');
});

// ── Estimated-usage runaway guard (#16228) ────────────────────────────────
// Production evidence: the z-ai/glm-5.2 gateway via llm.drytis.ai only ever
// reports estimated usage, so the strict real-report guard was permanently
// blind and runaway empty loops spun for hours. The estimate streak closes
// that hole with a deliberately looser threshold.

test('empty-output guard: estimate streak fires at estimateLimit when only estimates arrive (#16228)', () => {
	const breaches = [];
	const guard = createEmptyOutputGuard({ limit: 2, estimateLimit: 4, onBreach: r => breaches.push(r) });
	for (let i = 0; i < 3; i++) guard.observe({ inputTokens: 500, outputTokens: 0, estimated: true });
	assert.equal(breaches.length, 0, 'below the estimate limit: no breach');
	assert.equal(guard.estimatedEmptyStreak(), 3);
	guard.observe({ inputTokens: 500, outputTokens: 0, estimated: true });
	assert.equal(breaches.length, 1, 'fourth consecutive estimated empty breaches');
	assert.equal(guard.emptyStreak(), 0, 'the strict streak stays untouched by estimates');
});

test('empty-output guard: estimates alone never trip the strict limit (#16228)', () => {
	const breaches = [];
	const guard = createEmptyOutputGuard({ limit: 2, onBreach: r => breaches.push(r) });
	for (let i = 0; i < 50; i++) guard.observe({ inputTokens: 500, outputTokens: 0, estimated: true });
	assert.equal(breaches.length, 0, 'no estimateLimit configured → estimates stay inert');
});

test('empty-output guard: any output resets both streaks (#16228)', () => {
	const breaches = [];
	const guard = createEmptyOutputGuard({ limit: 2, estimateLimit: 3, onBreach: r => breaches.push(r) });
	guard.observe({ inputTokens: 500, outputTokens: 0, estimated: true });
	guard.observe({ inputTokens: 500, outputTokens: 0, estimated: true });
	guard.observe({ inputTokens: 500, outputTokens: 99, estimated: true });
	assert.equal(guard.estimatedEmptyStreak(), 0, 'estimated output resets the estimate streak');
	guard.observe({ inputTokens: 500, outputTokens: 0, estimated: true });
	guard.observe({ inputTokens: 500, outputTokens: 0, estimated: true });
	assert.equal(breaches.length, 0, 'streak restarted — two empties do not reach limit 3');
});

test('empty-output guard: real empty reports still use the strict limit (#16228)', () => {
	const breaches = [];
	const guard = createEmptyOutputGuard({ limit: 2, estimateLimit: 100, onBreach: r => breaches.push(r) });
	guard.observe({ inputTokens: 500, outputTokens: 0 });
	guard.observe({ inputTokens: 500, outputTokens: 0 });
	assert.equal(breaches.length, 1, 'real reports keep the original semantics');
});

test('empty-output guard: estimateLimit is clamped to at least 1 (#16228)', () => {
	const breaches = [];
	const guard = createEmptyOutputGuard({ limit: 5, estimateLimit: 0, onBreach: r => breaches.push(r) });
	guard.observe({ inputTokens: 500, outputTokens: 0, estimated: true });
	assert.equal(breaches.length, 0, 'estimateLimit 0 degenerates to inert, never trips the strict streak');
});
