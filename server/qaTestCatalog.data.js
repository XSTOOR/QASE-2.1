/**
 * Data for the standard QA test catalog (server/qaTestCatalog.js re-exports a
 * frozen copy). Kept separate so the catalog reads as a plain reviewable list.
 *
 * `category` groups the launcher grid ("standard" | "security").
 * `availability` marks checks that cannot run: unavailable ids are never valid
 * selections (see appQaSelection.js) and the launcher renders them disabled
 * with the reason. Reasons are user-visible — keep them honest and specific;
 * never invent a scenario to make a check available.
 */
export const QA_TEST_CATALOG = Object.freeze({
	version: '2026.10.1',
	tests: [
		{
			id: 'navigation',
			category: 'standard',
			title: 'Navigation & links',
			description: 'Primary menus, internal links, and back/forward behavior reach the right destinations.',
			focus: 'Exercise the primary navigation and representative internal links; verify each destination matches the link text and intent, including back-navigation after a route change.',
			availability: { available: true }
		},
		{
			id: 'forms',
			category: 'standard',
			title: 'Forms & validation',
			description: 'Required fields, input validation, error messages, and recovery on representative forms.',
			focus: 'Submit representative forms with empty, invalid, boundary, and corrected input; verify validation triggers, message clarity, preserved state, and recovery. Never create real records.',
			availability: { available: true }
		},
		{
			id: 'authentication',
			category: 'standard',
			title: 'Authentication',
			description: 'Sign-in/sign-up flows, session behavior, and sign-out — only when credentials are provided.',
			focus: 'If credentials are available in the vault, walk the sign-in and sign-out flows and check feedback for wrong credentials. Skip (do not fail) when no credentials exist.',
			availability: { available: true }
		},
		{
			id: 'search',
			category: 'standard',
			title: 'Search',
			description: 'Search entry, empty and no-result states, and result relevance on supported sites.',
			focus: 'Run representative searches including an empty query and a nonsense query; verify states and that results render and link correctly. Skip if the site has no search.',
			availability: { available: true }
		},
		{
			id: 'responsive',
			category: 'standard',
			title: 'Responsive layout',
			description: 'Layout, reflow, and reachable controls across desktop and narrow viewports.',
			focus: 'Check representative screens at desktop and narrow widths for overflow, clipping, overlap, and unreachable controls.',
			availability: { available: true }
		},
		{
			id: 'console_health',
			category: 'standard',
			title: 'Console & network health',
			description: 'Console errors, failed requests, and broken asset loads while exercising the site.',
			focus: 'Call browser_diagnostics during the other checks; report uncaught errors and failed essential requests (4xx/5xx) as findings, excluding Qase-side security blocks.',
			availability: { available: true }
		},
		{
			id: 'broken_links',
			category: 'standard',
			title: 'Broken links',
			description: 'Representative links actually resolve instead of 404ing or dead-ending.',
			focus: 'Sample representative links across the site and confirm each reaches a real page, applying the double-confirmation rule before reporting any link broken.',
			availability: { available: true }
		},
		{
			id: 'media',
			category: 'standard',
			title: 'Media & meetings',
			description: 'Images, video, and supported meeting links render and behave.',
			focus: 'Verify representative images and media render; test an observed supported meeting entry link only via browser_test_meeting_link.',
			availability: { available: true }
		},
		{
			id: 'security_authentication',
			category: 'security',
			title: 'Authentication',
			description: 'Login, logout, invalid credentials, and session handling — security-focused.',
			focus: 'Security review of authentication: attempt login with invalid credentials and confirm rejection with a generic error (no user enumeration); complete login and logout and confirm the session is invalidated (protected page redirects after logout); check session cookie handling where browser-observable (expiry, invalidation). Report a finding only with concrete evidence from the browser session. If the target has no login system, record the check as not tested with that reason — never fail it. Console errors alone are not a security result.',
			availability: { available: true }
		},
		{
			id: 'security_authorization',
			category: 'security',
			title: 'Permissions & authorization',
			description: 'Role restrictions and access to another user\u2019s protected data.',
			focus: 'Authorization review, only when two test accounts are available in the vault: sign in as the lower-privileged or second account and attempt to reach another user\u2019s protected resource directly (URL, identifier tampering). Secure behavior is a 403/404 or redirect to login — never the other user\u2019s data. Report only with evidence (the rendered response). Without two accounts, record not tested with that reason. Respect destructive-action confirmations; never modify another user\u2019s data.',
			availability: { available: true }
		},
		{
			id: 'security_input_validation',
			category: 'security',
			title: 'Input validation',
			description: 'Malformed, unexpected, and boundary-value inputs handled safely.',
			focus: 'Submit malformed, unexpected, and boundary-value inputs (oversized, wrong type, empty, special characters) to representative forms and query parameters. Secure behavior is graceful rejection (validation errors), never unhandled server errors, stack traces, or reflected raw input. Use browserFormAudit evidence where available. Keep payloads non-destructive and stay within the per-turn security payload limit. Record each input attempted and the observed response as evidence.',
			availability: { available: true }
		},
		{
			id: 'security_sql_injection',
			category: 'security',
			title: 'SQL injection',
			description: 'Inputs cannot change database-query behavior — browser-observable evidence only.',
			focus: 'Verify inputs cannot change database-query behavior, judged only from browser-observable evidence: database error text in responses, differential responses to syntactically-malicious vs benign equivalents of the same input, or authentication bypass. Use a small fixed set of safe, non-destructive payloads; do not flood the target (stay within the security payload limit). Absence of evidence is NOT proof of safety — when nothing observable differs, report the check outcome accordingly rather than claiming a pass on evidence that does not exist.',
			availability: { available: true }
		},
		{
			id: 'security_mitm',
			category: 'security',
			title: 'Man-in-the-middle scenarios',
			description: 'Not implemented — requires an agreed, configured MITM scenario.',
			focus: 'Not implemented. Requires an agreed, configured MITM scenario before this check can run; no scenario exists today, so this check is unavailable and must never execute or be reported as passed.',
			availability: { available: false, reason: 'Not implemented — requires an agreed, configured MITM scenario.' }
		},
		{
			id: 'security_dos',
			category: 'security',
			title: 'Denial-of-service scenarios',
			description: 'Not implemented — requires an agreed, configured DoS scenario.',
			focus: 'Not implemented. Requires an agreed, configured DoS scenario (defined scope, limits, and thresholds) before this check can run; none exist today, so this check is unavailable and must never execute or be reported as passed.',
			availability: { available: false, reason: 'Not implemented — requires an agreed, configured DoS scenario.' }
		}
	]
});
