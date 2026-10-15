import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	SECURITY_CHECK_IDS, XSS_CANARY,
	checkResponseHeaders, checkCookies, checkXssReflection,
	checkSqlErrorSignature, checkMixedContent
} from './securityChecks.js';

test('header checks flag missing headers and pass good ones', () => {
	const bare = checkResponseHeaders({ url: 'https://example.com', status: 200, headers: {} });
	const ids = bare.map(result => result.id);
	for (const id of ['csp', 'hsts', 'x_frame_options', 'x_content_type_options', 'referrer_policy']) {
		assert.ok(ids.includes(id), `${id} should be checked`);
		const entry = bare.find(result => result.id === id);
		assert.equal(entry.status, 'fail', `${id} missing should fail`);
		assert.equal(entry.category, 'security');
		assert.ok(entry.remediation, `${id} failure needs remediation text`);
	}

	const good = checkResponseHeaders({
		url: 'https://example.com', status: 200,
		headers: {
			'content-security-policy': "default-src 'self'; script-src 'self'",
			'strict-transport-security': 'max-age=31536000; includeSubDomains',
			'x-frame-options': 'DENY',
			'x-content-type-options': 'nosniff',
			'referrer-policy': 'strict-origin-when-cross-origin'
		}
	});
	for (const result of good) {
		assert.equal(result.status, 'pass', `${result.id} should pass with good headers`);
	}

	const unsafe = checkResponseHeaders({
		url: 'https://example.com', status: 200,
		headers: { 'content-security-policy': "script-src 'unsafe-inline' 'unsafe-eval'" }
	}).find(result => result.id === 'csp');
	assert.equal(unsafe.status, 'fail', "'unsafe-inline' script-src should fail");
});

test('cookie checks flag flagless session cookies and pass hardened ones', () => {
	const flagless = checkCookies({
		url: 'https://example.com',
		cookies: [{ name: 'session_id', value: 'x', httpOnly: true, secure: false, sameSite: undefined }]
	});
	assert.equal(flagless[0].status, 'fail');
	assert.match(flagless[0].evidence, /no Secure/);

	const hardened = checkCookies({
		url: 'https://example.com',
		cookies: [{ name: '__Secure-session', value: 'x', httpOnly: true, secure: true, sameSite: 'Lax' }]
	});
	// __Secure- prefixed cookies are excluded from the session set entirely.
	assert.equal(hardened[0].status, 'info');

	const allGood = checkCookies({
		url: 'https://example.com',
		cookies: [{ name: 'session_id', value: 'x', httpOnly: true, secure: true, sameSite: 'Lax' }]
	});
	assert.equal(allGood[0].status, 'pass');
});

test('XSS reflection distinguishes escaped, unescaped and absent', () => {
	const absent = checkXssReflection({ url: 'https://x.example', reflected: false, escaped: false });
	assert.equal(absent.status, 'pass');

	const escaped = checkXssReflection({ url: 'https://x.example', reflected: true, escaped: true });
	assert.equal(escaped.status, 'pass_with_issues');
	assert.equal(escaped.severity, 'low');

	const unescaped = checkXssReflection({ url: 'https://x.example', reflected: true, escaped: false });
	assert.equal(unescaped.status, 'fail');
	assert.equal(unescaped.severity, 'high');
});

test('SQL signature check matches driver errors and passes clean text', () => {
	const leak = checkSqlErrorSignature({
		url: 'https://x.example',
		responseText: '<pre>sqlite3.OperationalError: near "qase": syntax error</pre>'
	});
	assert.equal(leak.status, 'fail');
	assert.equal(leak.severity, 'high');

	const mysql = checkSqlErrorSignature({
		url: 'https://x.example',
		responseText: 'You have an error in your SQL syntax; check the manual'
	});
	assert.equal(mysql.status, 'fail');

	const clean = checkSqlErrorSignature({
		url: 'https://x.example',
		responseText: 'No results found. Try another search.'
	});
	assert.equal(clean.status, 'pass');
	assert.equal(clean.severity, 'info');
});

test('mixed content only applies to https documents and finds http subresources', () => {
	const notApplicable = checkMixedContent({ url: 'http://plain.example', requests: [{ url: 'http://cdn.example/x.png' }] });
	assert.equal(notApplicable.length, 1, 'http pages report the check as not applicable');
	assert.equal(notApplicable[0].status, 'pass');
	assert.equal(notApplicable[0].severity, 'info');
	const clean = checkMixedContent({ url: 'https://x.example', requests: [{ url: 'https://cdn.example/x.png' }] });
	assert.equal(clean[0].status, 'pass');
	const mixed = checkMixedContent({ url: 'https://x.example', requests: [{ url: 'http://cdn.example/x.png' }] });
	assert.equal(mixed[0].status, 'fail');
	assert.match(mixed[0].evidence, /http:\/\/cdn\.example/);
});

test('the canary payload is benign and every check id is stable', () => {
	assert.ok(!XSS_CANARY.includes('alert('), 'canary must not alert');
	assert.ok(XSS_CANARY.includes('<img'), 'canary carries a detectable markup fragment');
	assert.deepEqual(SECURITY_CHECK_IDS, [
		'csp', 'hsts', 'x_frame_options', 'x_content_type_options', 'referrer_policy',
		'cookie_flags', 'xss_reflection', 'sqli_error_signature', 'mixed_content'
	]);
});
