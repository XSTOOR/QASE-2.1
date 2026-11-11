/** A session allocated before runtime initialization is not a live agent yet. */
export function firstMatrixSessionId(run) {
	const items = (Array.isArray(run?.items) ? run.items : []).filter(item =>
		item && (item.startupPhase !== 'initializing' || item.status !== 'RUNNING'));
	return items.find(item => item?.sessionId && item.status === 'RUNNING')?.sessionId
		?? items.find(item => item?.sessionId)?.sessionId
		?? null;
}
