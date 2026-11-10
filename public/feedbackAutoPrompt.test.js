import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/* #16655 — Auto feedback pop-up after completion (all modes). Source-contract
 * tests: browser-session-scoped guard, wiring into the terminal SSE branches
 * for QA/SQA AND founder, and the preconditions (no prompt while a modal is
 * open or submitting; submitted runs land in View mode). */

const app = await readFile('public/app.js', 'utf8');

test('#16655 browser-session-scoped auto-prompt guard exists (module Set, not state)', () => {
	assert.match(app, /const feedbackAutoPrompted = new Set\(\);/, 'module-level Set declared');
	// NOT inside `state` — a refresh clears it, SPA navigation keeps it.
	const stateStart = app.indexOf('const state = {');
	const stateEnd = app.indexOf('};', stateStart);
	const stateBody = app.slice(stateStart, stateEnd);
	assert.doesNotMatch(stateBody, /feedbackAutoPrompted/, 'guard must live outside state');
});

test('#16655 maybeAutoPromptFeedback checks eligibility + once-per-run + same-run + modal-free', () => {
	const start = app.indexOf('async function maybeAutoPromptFeedback');
	assert.ok(start >= 0, 'maybeAutoPromptFeedback must exist');
	const end = app.indexOf('\n}', start);
	const body = app.slice(start, end);
	assert.match(body, /feedbackEligible\(session\)/, 'eligibility gate');
	assert.match(body, /feedbackAutoPrompted\.has\(session\.id\)/, 'once per run guard');
	assert.match(body, /state\.sessionId !== session\.id/, 'only the run being viewed');
	assert.match(body, /el\.feedbackModal\.open \|\| state\.feedback\.submitting/, 'never stack on an open modal / in-flight submit');
	assert.match(body, /feedbackAutoPrompted\.add\(session\.id\)/, 'run recorded before awaiting');
});

test('#16655 submitted runs land in View mode instead of a duplicate prompt', () => {
	const start = app.indexOf('async function maybeAutoPromptFeedback');
	const end = app.indexOf('\n}', start);
	const body = app.slice(start, end);
	assert.match(body, /if \(state\.feedback\.existing\) \{/, 'existing record short-circuits');
	assert.match(body, /applyFeedbackSubmittedState\(\);/, 'shows submitted state');
});

test('#16655 QA/SQA terminal branch auto-prompts after the completion view renders', () => {
	const marker = 'if (FEEDBACK_TERMINAL_STATUSES.has(event.status) && feedbackEligible(session)) {';
	const idx = app.indexOf(marker);
	assert.ok(idx >= 0, 'QA/SQA terminal branch must exist');
	const body = app.slice(idx, idx + 500);
	assert.match(body, /renderReport\(\);/, 'report content refreshes first');
	assert.doesNotMatch(body, /activateDetailTab|showCompletedQaResults/, 'completion preserves the selected tab');
	assert.match(body, /void syncFeedbackForSession\(session\);/, 'sync still runs');
	assert.match(body, /void maybeAutoPromptFeedback\(session\);/, 'auto-prompt wired after sync');
});

test('#16655 founder terminal branch auto-prompts after the completed report renders', () => {
	const marker = "if (session.mode === 'founder') {\n\t\t\t\trenderFounder();";
	const idx = app.indexOf(marker);
	assert.ok(idx >= 0, 'founder terminal branch must exist');
	const body = app.slice(idx, idx + 700);
	assert.match(body, /showCompletedFounderReport\(\);/, 'completed report view renders first');
	assert.match(body, /void syncFeedbackForSession\(session\);/, 'sync still runs');
	assert.match(body, /void maybeAutoPromptFeedback\(session\);/, 'auto-prompt wired after sync');
});

test('#16655 openFeedbackModal re-verifies the existing record (server truth, no duplicates)', () => {
	const start = app.indexOf('async function openFeedbackModal');
	const end = app.indexOf('\n}', start);
	const body = app.slice(start, end);
	assert.match(body, /api\(`\/sessions\/\$\{session\.id\}\/feedback`\)/, 'modal fetches the server record');
	assert.match(body, /state\.feedback\.existingLoadedFor !== session\.id/, 're-fetches for a new run');
});
