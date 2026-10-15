const CREDENTIAL_HINT = /\b(credentials?|password|passcode|username|user name|login|log in|sign in|sign-in|email and password|account)\b/i;

/**
 * Credential questions must use the vault form even when an older persisted
 * session carries credentialLike=false. Inspect both the prompt and choices so
 * a mixed "credentials or public-only" decision is handled safely.
 */
export function isCredentialQuestion(question = {}) {
	if (question.credentialLike === true) return true;
	const payload = question.planning_question ?? question;
	const options = Array.isArray(payload.options) ? payload.options : [];
	const haystack = [
		payload.question ?? '',
		...options.map(option => typeof option === 'string' ? option : (option?.label ?? ''))
	].join(' ');
	return CREDENTIAL_HINT.test(haystack);
}
