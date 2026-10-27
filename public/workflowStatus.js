import { runPresentationStatus } from './runPresentation.js';

/** Guidance derived from actual run state, never elapsed-time guesses. */
export function workflowStatus(session) {
	const status = runPresentationStatus(session);
	if (session?.pendingQuestion || status === 'awaiting_input') return { tone: 'attention', title: 'Qase needs your input', description: 'Answer the question below so testing can continue.', action: 'Answer question', destination: 'question' };
	if (status === 'blocked') return { tone: 'attention', title: 'Testing needs a prerequisite', description: 'Open the report to see what prevented testing and what to provide next.', action: 'Review blocker', destination: 'results' };
	if (status === 'partial') return { tone: 'attention', title: 'Testing completed with coverage gaps', description: session?.qaExecutionMode === 'hybrid' && session.hybrid?.budgetFinalizing
		? 'This run finished with its approved budget. Review the saved evidence and untested areas. Start a new test for remaining scope; continuing this closed run cannot reopen exploration.'
		: 'The browser sample finished. Review what was exercised and what remains untested; this is not a full-workflow pass.', action: 'Review coverage', destination: 'results' };
	if (status === 'done') return { tone: 'complete', title: 'Your results are ready', description: `${session?.findings?.length ?? 0} findings recorded. Review the report and evidence, then decide what to fix.`, action: 'Review results', destination: 'results' };
	if (status === 'running') return { hidden: true, tone: 'running', title: '', description: '', action: '', destination: null };
	if (status === 'error') return { tone: 'attention', title: 'This run needs attention', description: 'Read the latest message for the failure, then give Qase the context it needs to continue.', action: 'View latest message', destination: 'conversation' };
	if (status === 'interrupted') {
		const hybrid = session?.mode === 'qa' && session.qaExecutionMode === 'hybrid' ? session.hybrid : null;
		if (hybrid?.recovery?.resumeBlockedReason === 'usage_unverified' || (hybrid && /HYBRID_USAGE_UNRESOLVED|unverified prior usage receipt|usage must be reconciled|usage receipt.*reconcil/i.test(`${hybrid.pauseReason || ''} ${session.statusDetail || ''}`))) {
			const resumeBlocked = 'A provider usage receipt is missing. Usage reconciliation is required before this run can resume.';
			return { tone: 'attention', title: 'Progress saved · usage review needed', description: 'The model gateway did not return a verifiable usage receipt. Your collected evidence is preserved. This run needs provider usage reconciliation; repeatedly pressing Resume will not resolve it.', action: 'View saved progress', destination: 'progress', resumeBlocked };
		}
		if (hybrid && (hybrid.recovery?.resumeBlockedReason === 'budget_reached' || /HYBRID_MODEL_BUDGET|HYBRID_TIME_BUDGET|budget exhausted|exceeded.*budget/i.test(`${hybrid.pauseReason || ''} ${session.statusDetail || ''}`))) return {
			tone: 'attention', title: 'Progress saved · budget reached', description: 'This run reached its approved execution budget. Review the saved evidence and remaining scope before starting a new test with an approved budget.', action: 'View saved progress', destination: 'progress', resumeBlocked: 'This run has reached its approved budget.'
		};
		return { tone: 'attention', title: 'This run is paused', description: hybrid?.pauseReason ? `${hybrid.pauseReason} Your collected evidence is preserved.` : 'Your collected findings are still available. Resume when you are ready.', action: 'Review progress', destination: 'conversation' };
	}
	return { tone: 'idle', title: 'Ready for your instructions', description: 'Tell Qase which workflow or behavior you would like to check next.', action: 'Add an instruction', destination: 'composer' };
}
