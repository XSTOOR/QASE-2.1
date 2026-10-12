/**
 * Pipeline Phase 3 (#15493): unattended matrix-run question policy tests.
 *
 * The contract:
 *   - deriveQuestionPolicy honors ONLY confirmed authorizations.
 *   - Credential questions are NEVER auto-answered.
 *   - Destructive/irreversible confirmations are NEVER auto-approved.
 *   - Authorization-class questions ARE auto-answered under a confirmed
 *     authorization (and only then), with a basis recorded as evidence.
 *   - Everything else blocks with an honest, specific reason.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	deriveQuestionPolicy,
	autoAnswerFor,
	blockedReasonFor,
	MAX_AUTO_ANSWERS_PER_ITEM
} from './matrixQuestionPolicy.js';

test('Phase 3: policy derives ONLY from an explicitly confirmed authorization', () => {
	const run = { targetUrl: 'https://example.com' };
	assert.equal(deriveQuestionPolicy(undefined, run).authorized, false);
	assert.equal(deriveQuestionPolicy({}, run).authorized, false);
	assert.equal(deriveQuestionPolicy({ confirmed: false }, run).authorized, false);
	const ok = deriveQuestionPolicy({ confirmed: true }, run);
	assert.equal(ok.authorized, true);
	assert.match(ok.basis, /https:\/\/example\.com/);
});

test('Phase 3: credential questions are NEVER auto-answered — not even when authorized', () => {
	const policy = { authorized: true, basis: 'Authorized at run setup.' };
	const flagged = autoAnswerFor(policy, {
		question: 'Please provide login credentials for the site.',
		credentialLike: true
	});
	assert.equal(flagged, null);
	// Heuristic detection too (no credentialLike flag).
	const heuristic = autoAnswerFor(policy, {
		question: 'What is the username and password for this account?'
	});
	assert.equal(heuristic, null);
	// And the blocked reason tells the operator exactly what to do.
	assert.match(
		blockedReasonFor({ question: 'Please provide the password.' }),
		/needs sign-in credentials/
	);
});

test('Phase 3: destructive confirmations are NEVER auto-approved', () => {
	const policy = { authorized: true, basis: 'Authorized at run setup.' };
	for (const question of [
		'Confirm: delete the test account permanently?',
		'Should I proceed with the checkout and pay now?',
		'Permission to remove all uploaded records?',
		'May I send an invitation email to the team?',
		'Do you approve canceling this subscription?'
	]) {
		assert.equal(autoAnswerFor(policy, { question }), null, question);
	}
	assert.match(
		blockedReasonFor({ question: 'Confirm: delete the test account?' }),
		/destructive/
	);
});

test('Phase 3: authorization-class questions auto-answer under a confirmed authorization only', () => {
	const authorized = { authorized: true, basis: 'Operator confirmed https://t.example.' };
	const unauthorized = { authorized: false, basis: null };
	const question = { question: 'Do I have permission to run the security scan against this target?' };
	const yes = autoAnswerFor(authorized, question);
	assert.ok(yes, 'authorized run auto-answers a permission question');
	assert.match(yes.answer, /proceed/i);
	assert.match(yes.answer, /Operator confirmed/);
	assert.equal(autoAnswerFor(unauthorized, question), null, 'unauthorized run never auto-answers');
	// Scan continuation, isolated-environment class too.
	assert.ok(autoAnswerFor(authorized, { question: 'May I proceed with the intrusive security checks?' }));
	assert.ok(autoAnswerFor(authorized, { question: 'Is this an authorized test environment I may continue testing?' }));
	// No hint of authorization class → no auto-answer even when authorized.
	assert.equal(autoAnswerFor(authorized, { question: 'Which color scheme should the homepage use?' }), null);
});

test('Phase 3: blocked reasons are specific — generic fallback names the unattended context', () => {
	assert.match(
		blockedReasonFor({ question: 'Which plan should I choose?' }),
		/does not cover: "Which plan should I choose\?"/
	);
	assert.match(
		blockedReasonFor(null),
		/unattended/
	);
});

test('Phase 3: auto-answer bound is small and explicit (anti-loop)', () => {
	assert.ok(Number.isInteger(MAX_AUTO_ANSWERS_PER_ITEM));
	assert.ok(MAX_AUTO_ANSWERS_PER_ITEM >= 1 && MAX_AUTO_ANSWERS_PER_ITEM <= 5);
});
