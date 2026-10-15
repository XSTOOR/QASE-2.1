import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Feedback store tests run in an isolated CWD so .qase/feedback.json never
// collides with the developer's real instance data.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'qase-feedback-test-')));

const {
	createFeedback, getFeedback, findFeedbackForRun, listFeedback,
	updateFeedback, deleteFeedback, feedbackStats, loadFeedback,
	FEEDBACK_CATEGORIES, FEEDBACK_STATUSES
} = await import('../server/feedbackStore.js');

const RUN_ID = '1d0f4224-6c4a-4d3f-8f0a-52f6e6f61a10';
const RUN_ID_2 = '2e1f5335-7d5b-4e4f-9f1b-63a7f7f72b21';

const baseInput = { rating: 5, category: 'overall', comments: 'Great coverage, found real issues.' };

test('create stores a feedback record with run context, not user-entered run data', () => {
	const record = createFeedback({
		runId: RUN_ID, submittedBy: 'user-1',
		context: { targetUrl: 'https://example.com/', runStatus: 'done', durationSeconds: 92 },
		...baseInput
	});
	assert.ok(UUIDish(record.id));
	assert.equal(record.runId, RUN_ID);
	assert.equal(record.submittedBy, 'user-1');
	assert.equal(record.targetUrl, 'https://example.com/');
	assert.equal(record.runStatus, 'done');
	assert.equal(record.durationSeconds, 92);
	assert.equal(record.rating, 5);
	assert.equal(record.category, 'overall');
	assert.equal(record.status, 'new');
	assert.ok(Number.isFinite(record.submittedAt));
	assert.equal(getFeedback(record.id).id, record.id);
});

function UUIDish(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

test('duplicate feedback for the same run and user is rejected with the existing id', () => {
	const first = createFeedback({
		runId: RUN_ID_2, submittedBy: 'user-1',
		context: { runStatus: 'error' }, ...baseInput
	});
	assert.throws(
		() => createFeedback({ runId: RUN_ID_2, submittedBy: 'user-1', context: {}, ...baseInput }),
		error => error.code === 'duplicate_feedback' && error.existingId === first.id
	);
	// A different user CAN submit feedback for the same run.
	const second = createFeedback({
		runId: RUN_ID_2, submittedBy: 'user-2', context: {}, ...baseInput
	});
	assert.notEqual(second.id, first.id);
});

test('validation rejects bad ratings and categories; description is optional', () => {
	const cases = [
		{ rating: 0, category: 'overall', comments: 'x' },
		{ rating: 6, category: 'overall', comments: 'x' },
		{ rating: 2.5, category: 'overall', comments: 'x' },
		{ rating: 3, category: 'not_a_category', comments: 'x' }
	];
	for (const [index, input] of cases.entries()) {
		assert.throws(
			() => createFeedback({ runId: RUN_ID, submittedBy: `invalid-user-${index}`, context: {}, ...input }),
			error => error.code === 'invalid_input' && Object.keys(error.fields).length > 0,
			JSON.stringify(input)
		);
	}
	// Rating-only submissions are valid; category defaults to overall.
	for (const [index, input] of [
		{ rating: 4 },
		{ rating: 2, comments: '' },
		{ rating: 5, category: '' }
	].entries()) {
		const record = createFeedback({ runId: RUN_ID, submittedBy: `optional-user-${index}`, context: {}, ...input });
		assert.equal(record.category, 'overall');
		assert.equal(record.comments, '');
	}
});

test('comments are sanitized: control characters stripped, length capped', () => {
	const record = createFeedback({
		runId: RUN_ID, submittedBy: 'user-3', context: {},
		rating: 4, category: 'ui_ux',
		comments: 'ok\u0000but\u0007weird chars'.padEnd(4010, '.'),
		improvement: '  trim me  '
	});
	assert.ok(!record.comments.includes('\u0000'));
	assert.ok(record.comments.length <= 4000);
	assert.equal(record.improvement, 'trim me');
});

test('every feedback category is accepted', () => {
	for (const [index, category] of FEEDBACK_CATEGORIES.entries()) {
		const record = createFeedback({
			runId: RUN_ID, submittedBy: `cat-user-${index}`, context: {},
			rating: (index % 5) + 1, category, comments: `feedback for ${category}`
		});
		assert.equal(record.category, category);
	}
});

test('list filters by rating, category, status and search text', () => {
	const rows = listFeedback({ rating: 5, category: 'overall', limit: 500 });
	assert.ok(rows.length >= 2);
	assert.ok(rows.every(row => row.rating === 5 && row.category === 'overall'));
	const searched = listFeedback({ q: 'great coverage', limit: 500 });
	assert.ok(searched.length >= 1);
	const missing = listFeedback({ q: 'this text does not exist anywhere', limit: 500 });
	assert.equal(missing.length, 0);
	const forRun = findFeedbackForRun(RUN_ID, 'user-1');
	assert.equal(forRun.runId, RUN_ID);
	assert.equal(findFeedbackForRun(RUN_ID, 'nobody'), undefined);
});

test('update performs status transitions and content fixes with validation', () => {
	const record = createFeedback({
		runId: RUN_ID, submittedBy: 'upd-user', context: {},
		rating: 2, category: 'error_handling', comments: 'Error messages were unclear.'
	});
	assert.equal(record.status, 'new');
	const reviewed = updateFeedback(record.id, { status: 'reviewed' });
	assert.equal(reviewed.status, 'reviewed');
	const fixed = updateFeedback(record.id, { status: 'in_progress', comments: 'Clarified wording.' });
	assert.equal(fixed.status, 'in_progress');
	assert.equal(fixed.comments, 'Clarified wording.');
	assert.throws(
		() => updateFeedback(record.id, { status: 'not_a_status' }),
		error => error.code === 'invalid_input'
	);
	assert.throws(
		() => updateFeedback(record.id, { rating: 9 }),
		error => error.code === 'invalid_input'
	);
	for (const status of FEEDBACK_STATUSES) {
		updateFeedback(record.id, { status });
	}
});

test('delete removes the record', () => {
	const record = createFeedback({
		runId: RUN_ID, submittedBy: 'del-user', context: {},
		rating: 3, category: 'other', comments: 'delete me'
	});
	assert.equal(deleteFeedback(record.id), true);
	assert.equal(deleteFeedback(record.id), false);
	assert.equal(getFeedback(record.id), undefined);
});

test('stats aggregates totals, average rating and breakdowns', () => {
	const before = feedbackStats();
	assert.ok(before.total >= 1);
	assert.ok(Number.isFinite(before.averageRating));
	assert.ok(before.averageRating >= 1 && before.averageRating <= 5);
	for (const category of FEEDBACK_CATEGORIES) {
		assert.ok(Number.isInteger(before.byCategory[category]));
	}
	for (const status of FEEDBACK_STATUSES) {
		assert.ok(Number.isInteger(before.byStatus[status]));
	}
	assert.equal(Object.values(before.byRating).reduce((sum, count) => sum + count, 0), before.total);
});

test('records persist to disk and reload', async () => {
	const record = createFeedback({
		runId: RUN_ID, submittedBy: 'persist-user', context: {},
		rating: 5, category: 'ease_of_use', comments: 'persisted feedback'
	});
	// feedbackStore persists synchronously; simulate a fresh process by
	// re-reading the file the way loadFeedback does on a cold start.
	const raw = fs.readFileSync(path.join(process.cwd(), '.qase', 'feedback.json'), 'utf8');
	const parsed = JSON.parse(raw);
	assert.ok(parsed.some(row => row.id === record.id && row.comments === 'persisted feedback'));
});
