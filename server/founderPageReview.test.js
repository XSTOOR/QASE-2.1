import test from 'node:test';
import assert from 'node:assert/strict';
import { completedFounderPageReviews, createFounderPageReview, FOUNDER_PAGE_REVIEW } from './founderPageReview.js';
import { founderInvestigationCheckpoint } from './founderInvestigation.js';

function fixture({ afterCheck, response, session = { id: 'founder-page-review-fixture', activities: [] } } = {}) {
	const calls = [];
	const controller = new AbortController();
	let url = 'https://fixture.test/';
	let text = 'Public fixture page';
	const read = async () => ({ success: true, title: 'Fixture', text, totalCharacters: text.length, complete: true, url });
	const review = createFounderPageReview(session, {
		currentUrl: () => url,
		readCurrentPage: read,
		isCancelled: () => false,
		async invoke(tool, input, signal) {
			assert.equal(review.dispatchAllowed(), true);
			assert.equal(signal, controller.signal);
			calls.push([tool, input]);
			const activityId = `check-${session.activities.length + 1}`;
			afterCheck?.({ tool, controller, navigate: next => { url = next; } });
			const result = response?.(tool) ?? (tool === 'browser_read_page' ? await read() : { success: true });
			session.activities.push({ id: activityId, toolName: tool, input, status: result.success === false ? 'failed' : 'done' });
			return { activityId, result };
		}
	});
	return {
		session, calls, review,
		setPage(next, content) { url = next; if (content !== undefined) text = content; },
		run: (depth, args) => review.tool.run({ depth, ...args }, { signal: controller.signal }),
		save(id, result) {
			session.activities.push({ id, toolName: FOUNDER_PAGE_REVIEW, input: { depth: result.depth }, status: 'done', founderPageReview: result.reviewReceipt });
		}
	};
}

test('Founder page review composes only the fixed checks and returns their receipts', async () => {
	const failure = { outcome: 'fail', check: 'Overflow' };
	const f = fixture({
		response(tool) {
			if (tool === 'browser_qa_check') return { success: true, assertions: [...Array(12).fill({ outcome: 'pass' }), failure] };
			if (tool === 'browser_read_page') return { success: true, nextOffset: 5000, complete: false };
		}
	});
	const primary = await f.run('primary');
	assert.equal(primary.success, true);
	assert.deepEqual(f.calls, [
		['browser_snapshot', { limit: 40 }],
		['browser_read_page', { limit: 5000 }],
		['browser_qa_check', { action: 'accessibility' }],
		['browser_qa_check', { action: 'responsive' }],
		['browser_diagnostics', {}]
	]);
	assert.deepEqual(primary.checks.map(check => check.activity_id), ['check-1', 'check-2', 'check-3', 'check-4', 'check-5']);
	assert.equal(primary.checks[1].result.nextOffset, 5000);
	assert.equal(primary.checks[2].result.assertionCount, 13);
	assert.equal(primary.checks[2].result.failedCount, 1);
	assert.equal(primary.checks[2].result.assertions[0], failure);
	f.session.activities.push({ toolName: FOUNDER_PAGE_REVIEW, status: 'done', input: { depth: 'primary' } });
	assert.equal((await f.run('primary')).success, false);
	const supporting = await f.run('supporting');
	assert.deepEqual(supporting.checks.map(check => check.tool), ['browser_snapshot', 'browser_read_page']);
	assert.equal(f.calls.length, 7);
});

test('Founder page review releases dispatch and retains saved receipts after a cancelled or changed page', async () => {
	for (const change of [
		({ controller }) => controller.abort(),
		({ navigate }) => navigate('https://fixture.test/help')
	]) {
		const f = fixture({ afterCheck: change });
		const work = f.run('primary');
		assert.equal(f.review.dispatchAllowed(), false);
		const result = await work;
		assert.equal(result.success, false);
		assert.equal(result.checks.length, 1);
		assert.equal(result.checks[0].activity_id, 'check-1');
		assert.equal(f.review.dispatchAllowed(), true);
	}
});

test('completed page reviews carry the original child evidence through restoration and later activity', async () => {
	const home = 'https://fixture.test/help?view=guide#start';
	const first = fixture();
	first.setPage(home);
	const fresh = await first.run('supporting');
	first.save('help-review', fresh);
	first.session.activities.push(...Array.from({ length: 20 }, (_, index) => ({
		id: `later-${index}`, toolName: 'browser_get_url', status: 'done'
	})));
	const session = structuredClone({ ...first.session, founder: { observations: [] } });
	const restored = fixture({ session });
	restored.setPage(home);
	const cached = await restored.run('supporting');
	assert.equal(cached.reused, true);
	assert.equal(cached.review_id, 'help-review');
	assert.deepEqual(cached.checks.map(check => check.activity_id), fresh.checks.map(check => check.activity_id));
	assert.deepEqual(restored.calls, []);
	assert.deepEqual(founderInvestigationCheckpoint(session).completedPageReviews, [{
		route: 'https://fixture.test/help', depth: 'supporting', reviewId: 'help-review', checks: cached.checks
	}]);
	assert.equal(completedFounderPageReviews(session).length, 1);
	session.activities.find(activity => activity.id === cached.checks[0].activity_id).status = 'failed';
	assert.deepEqual(founderInvestigationCheckpoint(session).completedPageReviews, []);
	assert.ok((await restored.run('supporting')).reviewReceipt);
});

test('a changed sample, a distinct URL variant or an explicit state change gets new evidence', async () => {
	const url = 'https://fixture.test/help?view=guide';
	const f = fixture();
	f.setPage(url);
	f.save('original', await f.run('supporting'));
	f.setPage(url, 'Updated help text');
	assert.ok((await f.run('supporting')).reviewReceipt);
	f.setPage('https://fixture.test/help?view=faq', 'Public fixture page');
	assert.ok((await f.run('supporting')).reviewReceipt);
	f.setPage(url, 'Public fixture page');
	assert.ok((await f.run('supporting', { refresh_reason: 'The sidebar is expanded now.' })).reviewReceipt);
	assert.equal(f.calls.length, 8);
});
