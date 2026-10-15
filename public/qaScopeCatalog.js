/**
 * QA scope catalogue — shared by the frontend launcher, the API and the
 * reports. Server code imports this file directly (same pattern as
 * questionPresentation.js), so scope values have exactly one definition.
 */

/** Canonical scope option order (matches the Coverage selection UI). */
export const QA_SCOPE_OPTIONS = [
	{ value: 'desktop-layout', label: 'desktop layout and responsive behaviour across viewport widths', friendly: 'Desktop layout & responsive behaviour', group: 'uiux' },
	{ value: 'mobile-layout', label: 'mobile layout using an emulated phone viewport', friendly: 'Mobile layout', group: 'uiux' },
	{ value: 'ui-consistency', label: 'UI consistency: buttons, fonts, colors, spacing, forms, cards and navigation rendered consistently across pages', friendly: 'UI consistency', group: 'uiux' },
	{ value: 'content-validation', label: 'content and text validation: displayed text, labels, headings, messages and placeholders correct, readable, properly presented', friendly: 'Content & text validation', group: 'uiux' },
	{ value: 'browser-compatibility', label: 'cross-browser behaviour on the selected browser engines', friendly: 'Browser compatibility', group: 'uiux' },
	{ value: 'forms', label: 'forms and input validation (required fields, invalid input handling, submission feedback)', friendly: 'Functional Testing (forms & input validation)', group: 'other' },
	{ value: 'console-errors', label: 'console errors and failed network requests while browsing', friendly: 'Console & Network Health', group: 'other' },
	{ value: 'navigation', label: 'navigation and internal links (broken links, dead ends, back-navigation)', friendly: 'Navigation & Links', group: 'other' },
	{ value: 'accessibility', label: 'accessibility basics (labels, contrast, keyboard reachability, focus visibility)', friendly: 'Accessibility Testing', group: 'other' },
	{ value: 'security', label: 'security basics (header presence, cookie flags, XSS reflection, SQL injection error signatures) using the security_check tool', friendly: 'Security Testing', group: 'other' }
];

/** Scope values that are UI-level aliases for other controls, never sent to the agent. */
export const BROWSER_ONLY_SCOPE_VALUES = ['browser-compatibility'];

/**
 * Builds the kickoff instruction from the checked scope options.
 * - full sweep (all options, or no selection given) → null, meaning the plain
 *   URL is the whole kickoff and the agent tests everything.
 * - empty selection → null as well; the launcher guards against it and asks
 *   the user to check at least one item.
 * - anything in between → "Test this website, focusing on: …"
 */
export function buildQaKickoffMessage(values) {
	const agentOptions = QA_SCOPE_OPTIONS.filter(option => !BROWSER_ONLY_SCOPE_VALUES.includes(option.value));
	const selected = new Set(values ?? agentOptions.map(option => option.value));
	const chosen = agentOptions.filter(option => selected.has(option.value));
	if (chosen.length === 0) return null;
	if (chosen.length === agentOptions.length) return null; // plain URL = full sweep
	const parts = chosen.map(option => option.label).join('; ');
	return `Test this website, focusing on: ${parts}.`;
}

/**
 * Server-side whitelist/normalizer for persisted scope selections.
 * Unknown values are dropped; duplicates collapse; anything invalid returns
 * undefined so the run behaves exactly like a legacy run without scope.
 */
export function normalizeQaScopeSelection(values) {
	let input = values;
	if (typeof input === 'string') {
		// Tolerate raw JSON strings from non-pg drivers / serialized snapshots.
		try { input = JSON.parse(input); } catch { return undefined; }
	}
	if (!Array.isArray(input)) return undefined;
	const known = new Set(QA_SCOPE_OPTIONS.map(option => option.value));
	const out = [];
	for (const value of input) {
		if (typeof value === 'string' && known.has(value) && !out.includes(value)) out.push(value);
	}
	return out;
}
