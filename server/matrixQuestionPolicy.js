/**
 * Pipeline Phase 3 (#15493): unattended matrix runs — question policy.
 *
 * Matrix items run unattended: no human is watching, so a child session that
 * pauses on ask_question can never finish. The Start QA dialog ALREADY
 * collects an explicit security authorization (the operator confirms the
 * target is an authorized, isolated test environment) — that authorization is
 * the contract under which the whole run executes. Deriving a question policy
 * from it lets the orchestrator honor ALREADY-RESOLVED authorization without
 * weakening any genuine security control:
 *
 *   - Credential questions are NEVER auto-answered (no credentials exist in
 *     an unattended run; fabricating them is forbidden). Item stays BLOCKED
 *     with the question text.
 *   - Destructive-action confirmations are NEVER auto-approved, regardless of
 *     any authorization. Item stays BLOCKED with the question text.
 *   - Authorization-class questions (target permission, security-scan
 *     continuation, "may I proceed on this authorized target") are
 *     auto-answered ONLY when the run carries securityAuthorization.confirmed
 *     === true. Every auto-answer is recorded on the item as evidence — never
 *     a silent resume.
 *   - Anything else is NOT auto-answered. Item stays BLOCKED with the
 *     question text so the results board shows WHY.
 */

import { isCredentialQuestion } from '../public/questionPresentation.js';

/** Upper bound on auto-answers per item — an agent stuck re-asking must not
 *  loop forever; past this the item BLOCKS honestly. */
export const MAX_AUTO_ANSWERS_PER_ITEM = 3;

const DESTRUCTIVE_HINT = /\b(delete|removes?|destroys?|drops?|resets?|wipes?|irreversible|purchases?|payments?|pay\b|checkout|subscriptions?|cancels?|cancell\w+|unsubscribes?|unsubscrib\w+|invit\w+|unsubscribe)\b|\bsend(?:s|ing)?\b.*\b(message|email|e-mail|mail|invite|invitation)s?\b|\bchange\s+(?:the\s+)?(?:password|account settings)\b/i;

/** Authorization-class questions: permission/proceed/continue requests about
 *  the already-authorized target or its security scan. Deliberately narrow —
 *  when in doubt the item blocks. */
const AUTHORIZATION_HINT = /\b(authoriz\w*|permission|permitted|allowed to|approve[dl]?\b|may i|can i (?:proceed|continue|run|scan)|proceed with|continue with the (?:scan|test|security)|security scan|intrusive|isolated test environment)\b/i;

/**
 * Derives the auto-answer policy from the run's recorded authorization.
 * @param {object|null|undefined} securityAuthorization validated payload
 *   ({ confirmed: boolean, notes?: string }) or nothing.
 * @param {object|null} run the matrix run (targetUrl used in the answer text).
 * @returns {{ authorized: boolean, basis: string|null }}
 */
export function deriveQuestionPolicy(securityAuthorization, run = null) {
	const confirmed = securityAuthorization?.confirmed === true;
	return {
		authorized: confirmed,
		basis: confirmed
			? `Operator confirmed the target${run?.targetUrl ? ` ${run.targetUrl}` : ''} is an explicitly authorized, isolated test environment at run setup.`
			: null
	};
}

/**
 * Decides whether a pending question may be auto-answered under the policy.
 *
 * @param {{ authorized: boolean, basis: string|null }} policy
 * @param {object} question normalized pending question ({ question, options,
 *   credentialLike }) as stored on the session.
 * @returns {{ answer: string, basis: string } | null} null ⇒ do NOT
 *   auto-answer (the item must block honestly).
 */
export function autoAnswerFor(policy, question) {
	if (!question) return null;
	const text = String(question.question ?? '').trim();
	const options = Array.isArray(question.options) ? question.options : [];
	// Credential questions route to the vault form in interactive runs; an
	// unattended run has no one to supply them. Block, never fabricate.
	if (question.credentialLike === true || isCredentialQuestion({ question: text, options })) {
		return null;
	}
	// Destructive actions are never auto-approved — not by the QA
	// authorization, not by anything else. This mirrors the interactive
	// prompt contract (prompt.js: irreversible actions require a human).
	const haystack = [text, ...options.map((option) => option?.label ?? String(option ?? ''))].join(' ');
	if (DESTRUCTIVE_HINT.test(haystack)) {
		return null;
	}
	// Only authorization-class questions are auto-answerable, and only under
	// an explicit confirmed authorization.
	if (!policy?.authorized || !AUTHORIZATION_HINT.test(haystack)) {
		return null;
	}
	return {
		answer: 'Yes — proceed. '
			+ (policy.basis ?? 'The operator authorized this target at run setup.')
			+ ' This matrix run is unattended; continue without asking again for this authorization.',
		basis: policy.basis ?? 'Authorized at run setup.'
	};
}

/** Human-readable reason recorded on a BLOCKED item, from the question. */
export function blockedReasonFor(question) {
	const text = String(question?.question ?? '').trim();
	const options = Array.isArray(question?.options) ? question.options : [];
	const haystack = [text, ...options.map((option) => option?.label ?? String(option ?? ''))].join(' ');
	// Destructive check FIRST: the credential heuristic is broad (matches
	// "account"), and a destructive ask naming an account must read as the
	// never-auto-approved case, not a credentials ask.
	if (text && DESTRUCTIVE_HINT.test(haystack)) {
		return 'Session asked to confirm a destructive/irreversible action — never auto-approved. Confirm manually and retry this configuration.';
	}
	if (question?.credentialLike === true || (text && isCredentialQuestion({ question: text, options }))) {
		return 'Session needs sign-in credentials — matrix items run unattended. Add credentials to the run setup and retry this configuration.';
	}
	return text
		? `Session paused for an answer that the run authorization does not cover: "${text}"`
		: 'Session paused awaiting user input — matrix items run unattended.';
}
