import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const syncSource = source.slice(source.indexOf('async function syncFeedbackForSession('), source.indexOf('/**\n * Opens the feedback modal'));
const submitSource = source.slice(source.indexOf('async function submitFeedback('), source.indexOf('/* ── Transcript'));
function context(api) {
	const input = value => ({ value, textContent: '', disabled: false });
	const c = vm.createContext({ api, state: { sessionId: 'A', session: { id: 'A', status: 'done' }, feedback: { runId: 'A', rating: 5 } },
		el: { feedbackError: input(''), feedbackSubmit: input(''), feedbackCategory: input(''), feedbackComments: input('draft'), feedbackImprovement: input('improve') },
		feedbackEligible: () => true, applyFeedbackSubmittedState() {}, renderReport() {}, updateFeedbackSubmitEnabled() {}, toast() {}, refreshRuns: async () => {} });
	vm.runInContext(`let feedbackLoadGeneration = 0; ${syncSource}\n${submitSource}`, c);
	return c;
}
test('late feedback from run A cannot overwrite feedback loaded for run B', async () => {
	const pending = new Map();
	const c = context(path => new Promise(resolve => pending.set(path, resolve)));
	const a = c.syncFeedbackForSession({ id: 'A' });
	c.state.sessionId = 'B'; c.state.feedback.runId = 'B';
	const b = c.syncFeedbackForSession({ id: 'B' });
	pending.get('/sessions/B/feedback')({ id: 'feedback-B' }); await b;
	pending.get('/sessions/A/feedback')({ id: 'feedback-A' }); await a;
	assert.equal(c.state.feedback.existing.id, 'feedback-B');
});
test('feedback cannot submit against a different currently selected run', async () => {
	let posts = 0; const c = context(async () => { posts++; }); c.state.session.id = 'B';
	await c.submitFeedback({ preventDefault() {} });
	assert.equal(posts, 0); assert.match(c.el.feedbackError.textContent, /draft has not been submitted/);
});
test('retry after a lost save acknowledgement recovers the existing record and preserves the draft', async () => {
	const c = context(async path => {
		if (path === '/feedback') throw Object.assign(new Error('Already submitted'), { status: 409 });
		return { id: 'saved-feedback', runId: 'A' };
	});
	await c.submitFeedback({ preventDefault() {} });
	assert.equal(c.state.feedback.existing.id, 'saved-feedback'); assert.equal(c.state.feedback.editing, true);
	assert.equal(c.el.feedbackComments.value, 'draft'); assert.match(c.el.feedbackError.textContent, /already saved/);
});
