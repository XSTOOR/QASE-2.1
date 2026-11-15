/**
 * A run can finish its server lifecycle without completing any testing. Keep
 * that terminal lifecycle (`done`) separate from the outcome customers see.
 */
export function runPresentationStatus(session) {
	const status = String(session?.status ?? '').toLowerCase();
	const verdict = String(session?.mode === 'sqa'
		? session.sqa?.assessment?.verdict ?? session.sqaVerdict ?? session.reportVerdict ?? ''
		: session?.report?.verdict ?? session?.reportVerdict ?? '').toLowerCase();
	if (status === 'done' && session?.mode === 'sqa' && verdict === 'fail') return 'failed';
	if (status === 'done' && session?.qaExecutionMode === 'hybrid' && verdict === 'fail') return 'failed';
	if (status === 'done' && hasCoverageGaps(session)) return verdict === 'blocked' ? 'blocked' : 'partial';
	return status === 'done' && ['blocked', 'partial'].includes(verdict) ? verdict : status;
}

function hasCoverageGaps(session) {
	return session?.coverageIncomplete || (session?.qaExecutionMode === 'hybrid' && session.report?.notCovered?.length > 0);
}

export function runPresentationLabel(session) {
	const status = runPresentationStatus(session);
	if (status === 'blocked') return 'Blocked';
	if (status === 'failed') return session.qaExecutionMode === 'hybrid' && hasCoverageGaps(session) ? 'Failed with coverage gaps' : 'Failed';
	if (status === 'partial') return 'Completed with gaps';
	if (status === 'done') return 'Complete';
	if (status === 'running') return 'Running';
	if (status === 'awaiting_input') return 'Waiting for you';
	if (status === 'interrupted') return 'Paused';
	if (status === 'error') return 'Needs attention';
	return status ? status.replaceAll('_', ' ') : 'Idle';
}

/** Present the server's verified evidence without turning an unfinished check into a result. */
export function qaScenarioDisposition(scenario, runStatus) {
	if (scenario.failed > 0) return 'failed';
	if (scenario.absent) return 'absent';
	if (scenario.status === 'passed') {
		if (!(scenario.passed > 0)) return 'inconclusive';
		return scenario.incompleteRoutes || scenario.gaps?.length ? 'partial' : 'passed';
	}
	if (scenario.status === 'failed') return 'inconclusive';
	const endedOrPaused = ['done', 'error', 'interrupted', 'paused', 'cancelled'].includes(runStatus);
	if (endedOrPaused && scenario.status === 'running') return 'interrupted';
	if (endedOrPaused && scenario.status === 'planned') return 'not_executed';
	if (['running', 'blocked', 'inconclusive', 'partial', 'planned', 'not_executed', 'interrupted'].includes(scenario.status)) {
		return scenario.status;
	}
	return 'not_executed';
}

/** Blocker review must show the prerequisite, even when unrelated bugs exist. */
export function preferredResultTab(session, { sqaVisible = false, founderVisible = false } = {}) {
	if (runPresentationStatus(session) === 'blocked') return 'tab-report';
	if (session?.mode === 'sqa' && sqaVisible) return 'tab-sqa';
	if (session?.mode === 'founder' && founderVisible) return 'tab-founder';
	if (session?.mode === 'qa' && session.qaExecutionMode === 'hybrid') return 'tab-report';
	return session?.findings?.length ? 'tab-findings' : 'tab-report';
}

export function blockedRunReason(session) {
	if (runPresentationStatus(session) !== 'blocked') return '';
	if (session?.mode === 'sqa') return 'The quality assessment has unresolved controls. Review their missing evidence and any recorded execution limits in the quality report.';
	const gaps = session?.report?.notCovered;
	// Integrity failures are concrete global blockers. Optional skipped checks
	// (e.g. credentials or absent search) must not hide the actual reason.
	return gaps?.find?.(item => String(item ?? '').startsWith('Blocked:'))
		?? gaps?.find?.(item => String(item ?? '').trim())
		?? session?.report?.summary
		?? 'Testing could not proceed. Review the report for the blocking requirement.';
}
