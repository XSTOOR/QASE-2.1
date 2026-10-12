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

export function blockedRunReason(session) {
	if (runPresentationStatus(session) !== 'blocked') return '';
	return session?.report?.notCovered?.find?.(item => String(item ?? '').trim())
		?? session?.report?.summary
		?? 'Testing could not proceed. Review the report for the blocking requirement.';
}
