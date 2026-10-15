import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { mountDemoSite } from './demoSite.js';

/**
 * Fixture-driven validation of the security-check fixtures. The security
 * checks themselves are agent-driven (LLM judgment through a browser), but the
 * fixtures must be deterministic: the vulnerable variant exhibits exactly one
 * observable flaw per check, the safe variant behaves securely. If the
 * fixtures drift, the checks cannot be validated — so the fixtures get their
 * own contract tests here.
 */

async function startServer() {
	const app = express();
	mountDemoSite(app);
	const server = await new Promise(resolve => {
		const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	const base = `http://127.0.0.1:${server.address().port}`;
	const get = async path => {
		const response = await fetch(`${base}${path}`, { redirect: 'manual' });
		return { status: response.status, headers: response.headers, text: await response.text() };
	};
	const postForm = async (path, body) => {
		const response = await fetch(`${base}${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(body).toString(),
			redirect: 'manual'
		});
		return { status: response.status, headers: response.headers, text: await response.text() };
	};
	return { server, base, get, postForm };
}

test('authentication fixture: safe rejects generically, vulnerable enumerates users', async t => {
	const http = await startServer();
	t.after(() => http.server.close());

	// Safe login failures always redirect to the SAME generic error code —
	// the safe variant never emits user/password-specific codes.
	const safeUnknown = await http.postForm('/demo/security/safe/auth/login', {
		email: 'nobody@fixture.test', password: 'whatever-1'
	});
	assert.equal(safeUnknown.status, 302);
	assert.match(safeUnknown.headers.get('location') ?? '', /\/auth\?error=1$/);
	const safeWrongPw = await http.postForm('/demo/security/safe/auth/login', {
		email: 'alice@fixture.test', password: 'wrong-password'
	});
	assert.match(safeWrongPw.headers.get('location') ?? '', /\/auth\?error=1$/);
	// And the generic code renders the generic message only.
	const safeErrorPage = await http.get('/demo/security/safe/auth?error=1');
	assert.match(safeErrorPage.text, /Wrong email or password\./);
	assert.doesNotMatch(safeErrorPage.text, /No account exists|incorrect for this account/);

	// Vulnerable: distinct codes reveal account existence.
	const vulnUnknown = await http.postForm('/demo/security/vulnerable/auth/login', {
		email: 'nobody@fixture.test', password: 'whatever-1'
	});
	assert.match(vulnUnknown.headers.get('location') ?? '', /error=user$/);
	const vulnWrongPw = await http.postForm('/demo/security/vulnerable/auth/login', {
		email: 'alice@fixture.test', password: 'wrong-password'
	});
	assert.match(vulnWrongPw.headers.get('location') ?? '', /error=password$/);
	assert.match((await http.get('/demo/security/vulnerable/auth?error=password')).text, /password is incorrect for this account/);
	assert.match((await http.get('/demo/security/vulnerable/auth?error=user')).text, /No account exists/);

	// Login round-trips on both variants with correct credentials.
	const safeLogin = await http.postForm('/demo/security/safe/auth/login', {
		email: 'alice@fixture.test', password: 'alice-pass-1'
	});
	assert.equal(safeLogin.status, 302);
	assert.match(safeLogin.headers.get('set-cookie') ?? '', /fixture_session=/);
});

test('authentication fixture: safe invalidates the session on logout, vulnerable keeps it alive', async t => {
	const http = await startServer();
	t.after(() => http.server.close());

	for (const variant of ['safe', 'vulnerable']) {
		const login = await http.postForm(`/demo/security/${variant}/auth/login`, {
			email: 'alice@fixture.test', password: 'alice-pass-1'
		});
		const cookie = /fixture_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')?.[0];
		assert.ok(cookie, `${variant}: login sets a session cookie`);
		const withCookie = async path => fetch(`${http.base}${path}`, { headers: { cookie }, redirect: 'manual' });

		await withCookie(`/demo/security/${variant}/auth/logout`);
		const after = await withCookie(`/demo/security/${variant}/auth/account`);
		const afterText = await after.text();

		if (variant === 'safe') {
			// Secure: token destroyed server-side → account page redirects.
			assert.equal(after.status, 302);
			assert.match(after.headers.get('location') ?? '', /\/auth$/);
		} else {
			// Vulnerable: session survives logout → account page still renders.
			assert.equal(after.status, 200);
			assert.match(afterText, /Signed in as/);
		}
	}
});

test('authorization fixture: safe returns 403 on cross-user access, vulnerable leaks the record', async t => {
	const http = await startServer();
	t.after(() => http.server.close());

	// Sign in as Bob (viewer), then try Alice's record r1 directly.
	for (const variant of ['safe', 'vulnerable']) {
		const login = await http.get(`/demo/security/${variant}/authz/login?as=bob@fixture.test`);
		const cookie = /fixture_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')?.[0];
		const response = await fetch(`${http.base}/demo/security/${variant}/authz/records/r1`, { headers: { cookie }, redirect: 'manual' });

		if (variant === 'safe') {
			assert.equal(response.status, 403);
			assert.match(await response.text(), /Forbidden/);
		} else {
			assert.equal(response.status, 200);
			assert.match(await response.text(), /Alice invoice #001/);
		}
	}
});

test('input-validation fixture: safe rejects malformed input cleanly, vulnerable crashes and reflects', async t => {
	const http = await startServer();
	t.after(() => http.server.close());

	// Safe: missing fields and boundary violations get clean 400s.
	const safeMissing = await http.postForm('/demo/security/safe/input/submit', { message: '' });
	assert.equal(safeMissing.status, 400);
	assert.doesNotMatch(safeMissing.text, /TypeError|stack/i);
	const safeOversize = await http.postForm('/demo/security/safe/input/submit', { message: 'x'.repeat(201), quantity: '5' });
	assert.equal(safeOversize.status, 400);
	const safeBoundaryOk = await http.postForm('/demo/security/safe/input/submit', { message: 'hello', quantity: '100' });
	assert.equal(safeBoundaryOk.status, 200);

	// Vulnerable: missing input crashes with a stack trace; raw input echoed.
	const vulnMissing = await http.postForm('/demo/security/vulnerable/input/submit', { quantity: '5' });
	assert.equal(vulnMissing.status, 500);
	assert.match(vulnMissing.text, /at |Error/);
	const vulnReflect = await http.postForm('/demo/security/vulnerable/input/submit', { message: '<b>raw</b>', quantity: 'NaN' });
	assert.equal(vulnReflect.status, 200);
	assert.match(vulnReflect.text, /You said: <b>raw<\/b>/);
	// Boundary violation is NOT rejected on the vulnerable variant.
	const vulnOversize = await http.postForm('/demo/security/vulnerable/input/submit', { message: 'x'.repeat(201), quantity: '5' });
	assert.equal(vulnOversize.status, 200);
});

test('SQL-injection fixture: safe ignores query-shaping input, vulnerable leaks and errors', async t => {
	const http = await startServer();
	t.after(() => http.server.close());

	const injection = encodeURIComponent("' OR '1'='1");
	const quote = encodeURIComponent("wgt-a'");

	// Safe: injection payload is treated as a literal SKU → no results, no error.
	const safeInjected = await http.get(`/demo/security/safe/sqli/search?sku=${injection}`);
	assert.equal(safeInjected.status, 200);
	assert.match(safeInjected.text, /No product with that SKU\./);
	const safeQuoted = await http.get(`/demo/security/safe/sqli/search?sku=${quote}`);
	assert.equal(safeQuoted.status, 200);
	assert.match(safeQuoted.text, /No product with that SKU\./);
	const safeNormal = await http.get('/demo/security/safe/sqli/search?sku=wgt-a');
	assert.match(safeNormal.text, /Widget A/);

	// Vulnerable: classic OR 1=1 returns everything; a quote crashes with SQL text.
	const vulnInjected = await http.get(`/demo/security/vulnerable/sqli/search?sku=${injection}`);
	assert.equal(vulnInjected.status, 200);
	assert.match(vulnInjected.text, /Widget A/);
	assert.match(vulnInjected.text, /Widget B/);
	const vulnQuoted = await http.get(`/demo/security/vulnerable/sqli/search?sku=${quote}`);
	assert.equal(vulnQuoted.status, 500);
	assert.match(vulnQuoted.text, /SqlError/);
});

test('the practice site keeps its own behavior after the fixtures mount', async t => {
	const http = await startServer();
	t.after(() => http.server.close());

	const login = await http.get('/demo/login');
	assert.equal(login.status, 200);
	assert.match(login.text, /demo@qase\.dev/);
	const fixtureIndex = await http.get('/demo/security');
	assert.equal(fixtureIndex.status, 200);
	assert.match(fixtureIndex.text, /Safe variants/);
	assert.match(fixtureIndex.text, /Vulnerable variants/);
});
