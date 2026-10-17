import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/* #16653 — Founder-mode feedback enablement. Source-contract tests: founder
 * runs share the QA/SQA feedback flow (no client-side founder exclusion),
 * the founder completed report renders the same Provide/View button and the
 * USER FEEDBACK section, and the terminal-event path syncs feedback state
 * for founder runs. */

const app = await readFile('public/app.js', 'utf8');
const founderView = await readFile('public/founderView.js', 'utf8');

test('#16653 feedbackEligible covers every mode including founder', () => {
	const start = app.indexOf('function feedbackEligible');
	const body = app.slice(start, app.indexOf('}', app.indexOf('FEEDBACK_TERMINAL_STATUSES.has', start)) + 1);
	assert.ok(start >= 0, 'feedbackEligible must exist');
	assert.doesNotMatch(body, /founder/, 'feedbackEligible must not exclude founder runs');
	assert.match(body, /FEEDBACK_TERMINAL_STATUSES\.has\(session\.status\)/, 'eligibility keys off terminal statuses');
});

test('#16653 openFeedbackModal has no founder early-return', () => {
	const start = app.indexOf('async function openFeedbackModal');
	const body = app.slice(start, app.indexOf('async function', start + 10) > 0 ? app.indexOf('async function', start + 10) : start + 3000);
	assert.doesNotMatch(body, /mode !== 'founder'/, 'no founder gate inside the modal opener');
});

test('#16653 founder terminal event syncs feedback state', () => {
	const start = app.indexOf("if (session.mode === 'founder') {\n\t\t\t\trenderFounder();");
	const body = app.slice(start, app.indexOf('}', app.indexOf('showCompletedFounderReport();', start)) + 1);
	assert.ok(start >= 0, 'founder terminal branch must exist');
	assert.match(body, /syncFeedbackForSession\(session\)/, 'founder terminal branch must sync feedback');
	assert.match(body, /FEEDBACK_TERMINAL_STATUSES/, 'sync must be gated on terminal statuses');
});

test('#16653 founderView renders Provide/View Feedback button', () => {
	const start = founderView.indexOf('function renderFounderReportActions');
	const body = founderView.slice(start, founderView.indexOf('function appendFounderCompletedReport'));
	assert.ok(start >= 0, 'renderFounderReportActions must exist');
	assert.match(body, /Provide Feedback/, 'button label (blank state)');
	assert.match(body, /View Feedback/, 'button label (submitted state)');
	assert.match(body, /onProvideFeedback/, 'must invoke the controller callback');
	assert.match(body, /getFeedbackRating/, 'label state reads the rating record');
});

test('#16653 founder completed report embeds USER FEEDBACK section', () => {
	const start = founderView.indexOf('function appendFounderCompletedReport');
	const body = founderView.slice(start, founderView.indexOf('function renderSavedProjectState'));
	assert.match(body, /renderReportFeedbackSection/, 'completed report must render the feedback section');
	assert.match(body, /getFeedbackRating/, 'section reads the submitter record');
});

test('#16653 founderView receives feedback wiring from the controller', () => {
	const start = app.indexOf('const founderView = createFounderView({');
	const body = app.slice(start, app.indexOf('});', start));
	assert.match(body, /onProvideFeedback: \(\) => openFeedbackModal\(\)/, 'modal opener wired');
	assert.match(body, /renderReportFeedbackSection/, 'report section renderer wired');
});

test('#16653 modal run meta is mode-aware', () => {
	const start = app.indexOf('const modeLabel = session.mode');
	const body = app.slice(start, start + 400);
	assert.match(body, /Founder Review/, 'founder label');
	assert.match(body, /SQA Review/, 'SQA label');
	assert.match(body, /Test Run/, 'QA default');
});
