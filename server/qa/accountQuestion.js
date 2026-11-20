/**
 * The secure "test account" question shared by QA and SQA runs.
 *
 * Sets session.pendingQuestion (kind "qa_credentials", rendered as the sign-in
 * card), moves the run to awaiting_input and waits on record.qaAnswer, which
 * the /credentials and /answer routes call. Resolves
 * { credentials } | { skip } | { timeout } | { stopped } and the time waited.
 */
export function accountQuestion({ host, retry = false, reason, purpose = 'test' }) {
	return {
		kind: 'qa_credentials', credentialLike: true, options: [], allowCustom: false,
		question: retry ? 'Signing in didn\'t work. Try another test account?' : `${host} has a sign-in page. Should I ${purpose} the signed-in part too?`,
		summary: retry
			? `${reason ? `${reason}. ` : ''}Check the username and password, or continue with the public pages only.`
			: `So far I can ${purpose} only the public pages. Give me a test account and I'll sign in once and ${purpose} what's behind it, read-only: I won't submit forms, change settings or delete anything. Skip and I'll finish with the public pages.`
	};
}

export async function waitForAccount({ session, runStore, record, signal, waitMs, question, resumeDetail = 'Testing the site' }) {
	session.pendingQuestion = question;
	try { await runStore.commit(session, 'question', { question }); } catch { /* the card is best effort; the wait still times out */ }
	await runStore.setStatus(session, 'awaiting_input', 'Waiting for a test account');
	const waitStart = Date.now();
	const answer = await new Promise(resolve => {
		const done = value => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); if (record) record.qaAnswer = undefined; resolve(value); };
		const timer = setTimeout(() => done({ timeout: true }), waitMs);
		timer.unref?.();
		const onAbort = () => done({ stopped: true });
		if (signal?.aborted) return done({ stopped: true });
		signal?.addEventListener('abort', onAbort, { once: true });
		if (record) record.qaAnswer = done;
	});
	session.pendingQuestion = undefined;
	try { await runStore.commit(session, 'question', { question: null }); } catch { /* best effort */ }
	if (!answer.stopped) await runStore.setStatus(session, 'running', resumeDetail);
	if (answer.credentials) session.qaAuth = { ...(session.qaAuth ?? {}), authorized: true, ...(answer.credentials.loginUrl ? { loginUrl: answer.credentials.loginUrl } : {}) };
	return { answer, waitedMs: Date.now() - waitStart };
}
