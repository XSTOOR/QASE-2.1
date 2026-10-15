import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	aggregateRunStats,
	aggregateThumbs,
	percentOf,
	clockText,
	durationSummary,
	targetRows
} from '../public/analyticsView.js';

const run = (extra = {}) => ({
	status: 'completed',
	mode: 'qa',
	engine: 'chromium',
	findingCount: 0,
	...extra
});

test('aggregateRunStats counts status/mode/engine mix and findings', () => {
	const runs = [
		run(),
		run({ status: 'blocked', mode: 'sqa', engine: 'firefox', findingCount: 2 }),
		run({ status: 'running', mode: 'founder', engine: 'chromium', findingCount: 1 }),
		run({ status: 'error', engine: 'webkit' })
	];
	const stats = aggregateRunStats(runs);
	assert.equal(stats.total, 4);
	assert.equal(stats.completed, 1);
	assert.equal(stats.blocked, 2); // blocked + error
	assert.equal(stats.running, 1);
	assert.deepEqual(stats.byMode, { qa: 2, sqa: 1, founder: 1 });
	assert.deepEqual(stats.byEngine, { chromium: 2, firefox: 1, webkit: 1 });
	assert.equal(stats.findings, 3);
});

test('aggregateRunStats tolerates empty input and missing fields', () => {
	const stats = aggregateRunStats([]);
	assert.equal(stats.total, 0);
	assert.deepEqual(stats.byStatus, {});
	// null rows are skipped defensively; unknown/odd statuses are bucketed safely.
	const weird = aggregateRunStats([{}, null, { status: 5 }]);
	assert.equal(weird.total, 2);
	assert.equal(weird.byMode.qa, 2); // unknown modes normalize to qa
});

test('aggregateThumbs counts up/down votes only', () => {
	const runs = [
		{ feedback: { rating: 'up' } },
		{ feedback: { rating: 'down' } },
		{ feedback: { rating: 'up' } },
		{ feedback: { note: 'no rating' } },
		{}
	];
	assert.deepEqual(aggregateThumbs(runs), { up: 2, down: 1, total: 3 });
	assert.deepEqual(aggregateThumbs([]), { up: 0, down: 0, total: 0 });
});

test('percentOf guards zero totals and rounds', () => {
	assert.equal(percentOf(1, 4), 25);
	assert.equal(percentOf(2, 3), 67);
	assert.equal(percentOf(1, 0), 0);
	assert.equal(percentOf(NaN, 10), 0);
});

test('clockText formats h:mm:ss and rejects non-finite', () => {
	assert.equal(clockText(0), '0:00');
	assert.equal(clockText(65), '1:05');
	assert.equal(clockText(3725), '1:02:05');
	assert.equal(clockText(-1), '—');
	assert.equal(clockText(undefined), '—');
});

test('durationSummary prefers the durations aggregate, falls back to run rows', () => {
	const aggregate = {
		runCount: 7,
		avgDurationSeconds: 120,
		medianDurationSeconds: 90,
		minDurationSeconds: 30,
		maxDurationSeconds: 300
	};
	assert.deepEqual(durationSummary(aggregate, [{ status: 'completed', durationSeconds: 999 }]), {
		runCount: 7, avg: 120, median: 90, min: 30, max: 300
	});

	// No aggregate → derive from completed rows.
	const derived = durationSummary(undefined, [
		{ status: 'completed', durationSeconds: 60 },
		{ status: 'completed', durationSeconds: 30 },
		{ status: 'running', durationSeconds: 500 },
		{ status: 'completed' }
	]);
	assert.equal(derived.runCount, 2);
	assert.equal(derived.avg, 45);
	assert.equal(derived.median, 60); // sorted [30,60], index 1
	assert.equal(derived.min, 30);
	assert.equal(derived.max, 60);

	assert.deepEqual(durationSummary(undefined, []), {
		runCount: 0, avg: undefined, median: undefined, min: undefined, max: undefined
	});
});

test('targetRows sorts by run count, caps the list, filters junk', () => {
	const rows = targetRows([
		{ targetUrl: 'https://a.example', runCount: 2, avgDurationSeconds: 10 },
		{ targetUrl: 'https://b.example', runCount: 9, avgDurationSeconds: 20 },
		null,
		{ runCount: 3 },
		{ targetUrl: 'https://c.example', runCount: 5, avgDurationSeconds: 30 }
	], 2);
	assert.deepEqual(rows.map(r => r.targetUrl), ['https://b.example', 'https://c.example']);
	assert.deepEqual(targetRows([]), []);
});
