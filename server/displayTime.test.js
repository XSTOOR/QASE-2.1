import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDisplayTimeZone, formatFeedbackTimestamp, hasValidTimestamp } from './displayTime.js';

// 2026-10-13T12:55:00Z → 06:25 PM IST (the scenario from the task brief)
const IST_EXAMPLE_MS = Date.UTC(2026, 9, 13, 12, 55, 0);
// Midnight boundary: 2026-10-13T18:30:00Z → 2026-10-14 00:00 IST
const IST_MIDNIGHT_MS = Date.UTC(2026, 9, 13, 18, 30, 0);

test('resolveDisplayTimeZone: default is Asia/Kolkata when unset/empty', () => {
	assert.equal(resolveDisplayTimeZone({}), 'Asia/Kolkata');
	assert.equal(resolveDisplayTimeZone({ QASE_DISPLAY_TIMEZONE: '' }), 'Asia/Kolkata');
	assert.equal(resolveDisplayTimeZone(undefined), 'Asia/Kolkata');
});

test('resolveDisplayTimeZone: valid IANA names pass through', () => {
	assert.equal(resolveDisplayTimeZone({ QASE_DISPLAY_TIMEZONE: 'Asia/Kolkata' }), 'Asia/Kolkata');
	assert.equal(resolveDisplayTimeZone({ QASE_DISPLAY_TIMEZONE: ' UTC ' }), 'UTC');
	assert.equal(resolveDisplayTimeZone({ QASE_DISPLAY_TIMEZONE: 'America/New_York' }), 'America/New_York');
});

test('resolveDisplayTimeZone: invalid zone falls back to Asia/Kolkata (no throw)', () => {
	assert.equal(resolveDisplayTimeZone({ QASE_DISPLAY_TIMEZONE: 'Mars/Olympus' }), 'Asia/Kolkata');
	assert.equal(resolveDisplayTimeZone({ QASE_DISPLAY_TIMEZONE: 'not a zone' }), 'Asia/Kolkata');
});

test('formatFeedbackTimestamp: renders the IST example exactly', () => {
	assert.equal(formatFeedbackTimestamp(IST_EXAMPLE_MS, 'Asia/Kolkata'), '13-Oct-2026 06:25 PM IST');
});

test('formatFeedbackTimestamp: same output regardless of process TZ (server zone independence)', () => {
	process.env.TZ = 'America/New_York';
	assert.equal(formatFeedbackTimestamp(IST_EXAMPLE_MS, 'Asia/Kolkata'), '13-Oct-2026 06:25 PM IST');
	process.env.TZ = 'UTC';
	assert.equal(formatFeedbackTimestamp(IST_EXAMPLE_MS, 'Asia/Kolkata'), '13-Oct-2026 06:25 PM IST');
	delete process.env.TZ;
});

test('formatFeedbackTimestamp: default zone is Asia/Kolkata', () => {
	assert.equal(formatFeedbackTimestamp(IST_EXAMPLE_MS), '13-Oct-2026 06:25 PM IST');
	assert.equal(formatFeedbackTimestamp(IST_EXAMPLE_MS, ''), '13-Oct-2026 06:25 PM IST');
	assert.equal(formatFeedbackTimestamp(IST_EXAMPLE_MS, undefined), '13-Oct-2026 06:25 PM IST');
});

test('formatFeedbackTimestamp: midnight crossing rolls the DATE, not just the time', () => {
	assert.equal(formatFeedbackTimestamp(IST_MIDNIGHT_MS, 'Asia/Kolkata'), '14-Oct-2026 12:00 AM IST');
});

test('formatFeedbackTimestamp: UTC renders with UTC label', () => {
	assert.equal(formatFeedbackTimestamp(IST_EXAMPLE_MS, 'UTC'), '13-Oct-2026 12:55 PM UTC');
});

test('formatFeedbackTimestamp: other zones render with offset label', () => {
	assert.equal(formatFeedbackTimestamp(IST_EXAMPLE_MS, 'America/New_York'), '13-Oct-2026 08:55 AM UTC-04:00');
});

test('formatFeedbackTimestamp: invalid zone falls back (never throws, never wrong offset)', () => {
	assert.equal(formatFeedbackTimestamp(IST_EXAMPLE_MS, 'Mars/Olympus'), '13-Oct-2026 06:25 PM IST');
});

test('formatFeedbackTimestamp: missing/invalid timestamp renders the em dash safely', () => {
	assert.equal(formatFeedbackTimestamp(Number.NaN, 'Asia/Kolkata'), '—');
	assert.equal(formatFeedbackTimestamp(undefined, 'Asia/Kolkata'), '—');
});

test('hasValidTimestamp guards', () => {
	assert.equal(hasValidTimestamp(0), true);
	assert.equal(hasValidTimestamp(Number.NaN), false);
	assert.equal(hasValidTimestamp(undefined), false);
});

test('12-hour formatting: hours map 13 → 01 PM, 0 → 12 AM', () => {
	const onePmIst = Date.UTC(2026, 9, 13, 7, 30, 0); // 13:00 IST
	assert.equal(formatFeedbackTimestamp(onePmIst, 'Asia/Kolkata'), '13-Oct-2026 01:00 PM IST');
	const midnightIst = Date.UTC(2026, 9, 13, 18, 30, 0); // 00:00 IST next day
	assert.equal(formatFeedbackTimestamp(midnightIst, 'Asia/Kolkata'), '14-Oct-2026 12:00 AM IST');
});
