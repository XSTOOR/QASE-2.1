/**
 * A run can finish its server lifecycle without completing any testing. Keep
 * that terminal lifecycle (`done`) separate from the outcome customers see.
 */
export function runPresentationStatus(session) {
	const status = String(session?.status ?? '').toLowerCase();
	const verdict = String(session?.report?.verdict ?? session?.reportVerdict ?? '').toLowerCase();
	return status === 'done' && verdict === 'blocked' ? 'blocked' : status;
}

export function runPresentationLabel(session) {
	const status = runPresentationStatus(session);
	if (status === 'blocked') return 'Blocked';
	if (status === 'done') return 'Complete';
	if (status === 'running') return 'Running';
	if (status === 'awaiting_input') return 'Waiting for you';
	if (status === 'interrupted') return 'Paused';
	if (status === 'error') return 'Needs attention';
	return status ? status.replaceAll('_', ' ') : 'Idle';
}

/** Blocker review must show the prerequisite, even when unrelated bugs exist. */
export function preferredResultTab(session, { sqaVisible = false, founderVisible = false } = {}) {
	if (runPresentationStatus(session) === 'blocked') return 'tab-report';
	if (session?.mode === 'sqa' && sqaVisible) return 'tab-sqa';
	if (session?.mode === 'founder' && founderVisible) return 'tab-founder';
	return session?.findings?.length ? 'tab-findings' : 'tab-report';
}

export function blockedRunReason(session) {
	if (runPresentationStatus(session) !== 'blocked') return '';
	const gaps = session?.report?.notCovered;
	// Integrity failures are concrete global blockers. Optional skipped checks
	// (e.g. credentials or absent search) must not hide the actual reason.
	return gaps?.find?.(item => String(item ?? '').startsWith('Blocked:'))
		?? gaps?.find?.(item => String(item ?? '').trim())
		?? session?.report?.summary
		?? 'Testing could not proceed. Review the report for the blocking requirement.';
}
