/** Explicit per-run preferences win over lifecycle defaults while frames stream. */
export function previewCollapsed({ available, status, hasSession, preference }) {
	if (!available) return ['done', 'error', 'interrupted', 'cancelled'].includes(status);
	if (typeof preference === 'boolean') return preference;
	return Boolean(hasSession) && ['done', 'error', 'interrupted', 'idle', 'cancelled'].includes(status);
}
