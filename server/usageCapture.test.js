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
	assert.deepEqual(usage, { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cachedInputTokens: 0, estimated: false, updatedAt: usage.updatedAt });
	usage = applyUsage(usage, { inputTokens: 500, outputTokens: 100, totalTokens: 600, cachedInputTokens: 50 });
	assert.equal(usage.inputTokens, 1500);
	assert.equal(usage.outputTokens, 300);
	assert.equal(usage.totalTokens, 1800);
	assert.equal(usage.cachedInputTokens, 50);
	assert.equal(usage.estimated, false);
	// An estimate after a real report is discarded.
	usage = applyUsage(usage, { inputTokens: 5, outputTokens: 5, estimated: true });
	assert.equal(usage.inputTokens, 1500, 'estimate must not override real usage');
	// A pure-estimate run is marked as such.
	const estimate = applyUsage(base, { inputTokens: 5, outputTokens: 5, estimated: true });
	assert.equal(estimate.estimated, true);
	assert.equal(estimate.totalTokens, 10);
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
