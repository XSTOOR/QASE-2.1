/**
 * "Test these next" follow-up builder for completed QA runs. Pure — no DOM —
 * so the dashboard and the unit tests share one definition.
 *
 * Not-covered items and recommendations from the report become suggested next
 * tests; every suggestion is pre-checked because users hit select-all.
 */

/** Collects the follow-up candidates from a finished QA report. */
export function followUpSuggestions(report) {
	const items = [];
	for (const item of report?.notCovered ?? []) {
		if (typeof item === 'string' && item.trim()) items.push(item.trim());
	}
	for (const item of report?.recommendations ?? []) {
		if (typeof item === 'string' && item.trim()) items.push(item.trim());
	}
	// Dedupe case-insensitively while preserving order.
	const seen = new Set();
	return items.filter(item => {
		const key = item.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * Builds the kickoff message for a follow-up run against the same target URL.
 * `selected` holds the checked suggestion strings.
 */
export function buildFollowUpMessage(targetUrl, selected) {
	const chosen = (selected ?? []).filter(item => typeof item === 'string' && item.trim());
	if (!targetUrl || chosen.length === 0) return null;
	const lines = chosen.map(item => `- ${item}`).join('\n');
	return [
		`Run a focused QA pass on ${targetUrl}.`,
		'A previous QA run left these areas untested or recommended follow-up:',
		lines,
		'Cover these items now and file anything you find.'
	].join('\n');
}
