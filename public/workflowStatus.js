import { runPresentationStatus } from './runPresentation.js';

/** Guidance derived from actual run state, never elapsed-time guesses. */
export function workflowStatus(session) {
	const status = runPresentationStatus(session);
	if (session?.pendingQuestion || status === 'awaiting_input') return { tone: 'attention', title: 'Qase needs your input', description: 'Answer the question below so testing can continue.', action: 'Answer question', destination: 'question' };
	if (status === 'blocked') return { tone: 'attention', title: 'Testing needs a prerequisite', description: 'Open the report to see what prevented testing and what to provide next.', action: 'Review blocker', destination: 'results' };
	if (status === 'done') return { tone: 'complete', title: 'Your results are ready', description: `${session?.findings?.length ?? 0} findings recorded. Review the report and evidence, then decide what to fix.`, action: 'Review results', destination: 'results' };
	if (status === 'running') return { hidden: true, tone: 'running', title: '', description: '', action: '', destination: null };
	if (status === 'error') return { tone: 'attention', title: 'This run needs attention', description: 'Read the latest message for the failure, then give Qase the context it needs to continue.', action: 'View latest message', destination: 'conversation' };
	if (status === 'interrupted') return { tone: 'attention', title: 'This run is paused', description: 'Your collected findings are still available. Resume when you are ready.', action: 'Review progress', destination: 'conversation' };
	return { tone: 'idle', title: 'Ready for your instructions', description: 'Tell Qase which workflow or behavior you would like to check next.', action: 'Add an instruction', destination: 'composer' };
}
