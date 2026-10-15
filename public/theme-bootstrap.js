/**
 * theme-bootstrap — no-flash theme application (#14383).
 *
 * MUST stay an external file: the app's CSP is script-src 'self' and blocks
 * inline bootstrap scripts (hard lesson from the reverted React UI work).
 * Loaded first in <head>, before paint, so the stored preference colors the
 * very first frame — no flash of the wrong theme.
 *
 * Mirrors themePreference.js's resolution logic in ~15 dependency-free lines;
 * importing the module here would delay it behind the module graph, and a
 * shared module fetch is a paint-latency cost this file exists to avoid.
 */
(function () {
	var KEY = 'qase.theme';
	var preference = 'dark'; // default: the historical appearance
	try {
		var raw = globalThis.localStorage && globalThis.localStorage.getItem(KEY);
		if (typeof raw === 'string') {
			raw = raw.trim().toLowerCase();
			if (raw === 'light' || raw === 'dark' || raw === 'system') preference = raw;
		}
	} catch (error) { /* storage unavailable → default dark */ }

	var applied = preference;
	if (preference === 'system') {
		applied = 'dark';
		try {
			var query = globalThis.matchMedia && globalThis.matchMedia('(prefers-color-scheme: dark)');
			if (query) applied = query.matches ? 'dark' : 'light';
		} catch (error) { /* matchMedia unavailable → dark */ }
	}

	var root = globalThis.document && globalThis.document.documentElement;
	if (root) root.setAttribute('data-theme', applied === 'light' ? 'light' : 'dark');
})();
