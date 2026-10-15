/**
 * Deterministic security checks run host-side against the current page.
 *
 * The model never receives an arbitrary-JS tool. It invokes `security_check`,
 * the host inspects the live page and the responses it already produced, and
 * every check returns a structured result the model reports through the
 * existing `report_finding` channel (category "security").
 *
 * Checks are deliberately passive/benign: no destructive payloads, no
 * time-based SQLi, no external payload lists. Anything that needs active
 * requests reuses the page's own forms so the browser policy stays in charge
 * of the destination.
 */

/** Canary payload: detectable in the DOM, harmless if executed/escaped. */
export const XSS_CANARY = 'qz7"\'<img src=x onerror=qaseXssProbe()>-qz7';

/**
 * Signature pool for SQL-driver errors. Matched case-insensitively against
 * response text and error UI shown to the user after a benign quote payload.
 */
const SQL_ERROR_SIGNATURES = [
	/sqlite3?\.(operational|database|programming)error/i,
	/mysql[0-9]*\s*\*+/i,
	/you have an error in your sql syntax/i,
	/unterminated quoted string/i,
	/pg_query\(\)|psql.*(warning|error)/i,
	/postgresql.*(syntax|error)/i,
	/ora-\d{5}/i,
	/microsoft sql (server|native client)/i,
	/sqlserver jdbc driver/i,
	/sqlite3?::(sqlexception|exception)/i,
	/warning: sqlite/i,
	/bestmatchtable\[[^\]]+\] where/i
];

/** Header checks applied to a captured main-document response. */
export function checkResponseHeaders({ url, status, headers = {} }) {
	const results = [];
	const header = name => {
		for (const [key, value] of Object.entries(headers)) {
			if (key.toLowerCase() === name.toLowerCase()) return String(value);
		}
		return undefined;
	};
	const push = (id, severity, pass, evidence, remediation) => results.push({
		id, title: id, category: 'security', severity, status: pass ? 'pass' : 'fail',
		url, evidence, remediation
	});

	const csp = header('content-security-policy');
	if (csp) {
		const unsafeInline = /script-src[^;]*'unsafe-inline'/i.test(csp) || !/script-src|default-src/i.test(csp);
		push('csp', unsafeInline ? 'medium' : 'low', !unsafeInline,
			`Content-Security-Policy: ${csp.slice(0, 300)}`,
			unsafeInline ? "CSP allows inline scripts ('unsafe-inline' or no script-src). Restrict script sources." : undefined);
	} else {
		push('csp', 'medium', false, 'No Content-Security-Policy header on the document response.',
			'Add a Content-Security-Policy header restricting script/style/img sources.');
	}

	const hsts = header('strict-transport-security');
	if (!hsts) {
		push('hsts', 'medium', false, 'No Strict-Transport-Security header.',
			'Serve Strict-Transport-Security: max-age=31536000; includeSubDomains over HTTPS.');
	} else {
		const strong = /max-age=(\d{3,})/i.test(hsts) && Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? 0) >= 15552000;
		push('hsts', strong ? 'low' : 'medium', true,
			`Strict-Transport-Security: ${hsts}`,
			strong ? undefined : 'Raise max-age to at least 180 days (15552000s).');
	}

	const xfo = header('x-frame-options');
	const frameAncestors = /frame-ancestors/i.test(String(csp ?? ''));
	push('x_frame_options', 'low', Boolean(xfo) || frameAncestors,
		xfo ? `X-Frame-Options: ${xfo}` : (frameAncestors ? 'CSP frame-ancestors present.' : 'No X-Frame-Options or CSP frame-ancestors.'),
		(xfo || frameAncestors) ? undefined : 'Add X-Frame-Options: DENY/SAMEORIGIN or a CSP frame-ancestors directive to prevent clickjacking.');

	const xcto = header('x-content-type-options');
	push('x_content_type_options', 'low', /nosniff/i.test(String(xcto ?? '')),
		xcto ? `X-Content-Type-Options: ${xcto}` : 'No X-Content-Type-Options header.',
		/nosniff/i.test(String(xcto ?? '')) ? undefined : 'Add X-Content-Type-Options: nosniff.');

	const referrer = header('referrer-policy');
	push('referrer_policy', 'low', Boolean(referrer),
		referrer ? `Referrer-Policy: ${referrer}` : 'No Referrer-Policy header.',
		referrer ? undefined : 'Add Referrer-Policy: strict-origin-when-cross-origin (or stricter).');

	return results;
}

/** Cookie-flag check on the current page's cookies (document + header forms). */
export function checkCookies({ url, cookies = [], documentCookie = '' }) {
	const results = [];
	const session = cookies.filter(cookie => cookie.name && !/^(__Host-|__Secure-)/.test(cookie.name)
		&& (cookie.httpOnly === true || /session|auth|token|sid|login/i.test(cookie.name)));
	const flagless = session.filter(cookie => !cookie.httpOnly || !cookie.secure || !cookie.sameSite);
	if (!session.length) {
		results.push({
			id: 'cookie_flags', title: 'cookie_flags', category: 'security', severity: 'info',
			status: 'info', url, evidence: documentCookie
				? 'Cookies visible to document.cookie exist; verify flags server-side.'
				: 'No session cookies observed on this page.',
			remediation: undefined
		});
		return results;
	}
	const detail = flagless.map(cookie =>
		`${cookie.name}: ${cookie.httpOnly ? '' : 'no HttpOnly; '}${cookie.secure ? '' : 'no Secure; '}${cookie.sameSite ? '' : 'no SameSite'}`)
		.join(' | ');
	results.push({
		id: 'cookie_flags', title: 'cookie_flags', category: 'security',
		severity: flagless.length ? 'medium' : 'info',
		status: flagless.length ? 'fail' : 'pass',
		url,
		evidence: detail || 'All observed session cookies carry HttpOnly, Secure and SameSite.',
		remediation: flagless.length ? 'Set HttpOnly, Secure and SameSite=Lax (or Strict) on session cookies.' : undefined
	});
	return results;
}

/**
 * Reflection probe result. `reflected` is true when the canary appears in the
 * DOM; `escaped` is true when it appears as text (no live probe element) and
 * false when an executable construct (the probe img/onerror) survived.
 */
export function checkXssReflection({ url, reflected, escaped }) {
	if (!reflected) {
		return {
			id: 'xss_reflection', title: 'xss_reflection', category: 'security', severity: 'info',
			status: 'pass', url,
			evidence: 'The benign canary payload was submitted but not reflected on the response page.',
			remediation: undefined
		};
	}
	return {
		id: 'xss_reflection', title: 'xss_reflection', category: 'security',
		severity: escaped ? 'low' : 'high',
		status: escaped ? 'pass_with_issues' : 'fail',
		url,
		evidence: escaped
			? 'Payload reflected but HTML-escaped (renders as text).'
			: 'Payload reflected unescaped — executable markup survived into the page (stored/reflected XSS).',
		remediation: escaped
			? 'Reflection exists; keep encoding on every sink and avoid URL-based state.'
			: 'HTML-encode the reflected value on the server (contextual output encoding).'
	};
}

/**
 * SQL-injection error signature check. Benign quote payload only; a match
 * means driver errors leak into the response, which is both an info leak and
 * a strong SQLi indicator for the model to investigate.
 */
export function checkSqlErrorSignature({ url, responseText, errorText }) {
	const haystack = [responseText, errorText].filter(Boolean).join('\n').slice(0, 200_000);
	const match = SQL_ERROR_SIGNATURES.find(pattern => pattern.test(haystack));
	return {
		id: 'sqli_error_signature', title: 'sqli_error_signature', category: 'security',
		severity: match ? 'high' : 'info',
		status: match ? 'fail' : 'pass',
		url,
		evidence: match
			? `Database error signature leaked after a benign quote payload: ${match.source}`
			: 'No database error signature observed after a benign quote payload.',
		remediation: match
			? 'Use parameterized queries, disable verbose driver errors in production responses, and return generic error pages.'
			: undefined
	};
}

/** Mixed-content: any http:// subresource on an https:// document. */
export function checkMixedContent({ url, requests = [] }) {
	let origin;
	try { origin = new URL(url).protocol; } catch { return []; }
	if (origin !== 'https:') {
		// Not applicable — still reported so the suite summary shows the check ran.
		return [{
			id: 'mixed_content', title: 'mixed_content', category: 'security',
			severity: 'info', status: 'pass', url,
			evidence: 'The document is not served over https://; mixed content is not applicable to http:// pages.',
			remediation: undefined
		}];
	}
	const insecure = requests.filter(request => {
		try { return new URL(request.url).protocol === 'http:'; } catch { return false; }
	});
	return [{
		id: 'mixed_content', title: 'mixed_content', category: 'security',
		severity: insecure.length ? 'medium' : 'info',
		status: insecure.length ? 'fail' : 'pass',
		url,
		evidence: insecure.length
			? `Insecure http:// subresources: ${insecure.slice(0, 5).map(r => r.url).join(', ')}`
			: 'No http:// subresources on the https:// document.',
		remediation: insecure.length ? 'Load every subresource over https://.' : undefined
	}];
}

export const SECURITY_CHECK_IDS = [
	'csp', 'hsts', 'x_frame_options', 'x_content_type_options', 'referrer_policy',
	'cookie_flags', 'xss_reflection', 'sqli_error_signature', 'mixed_content'
];
