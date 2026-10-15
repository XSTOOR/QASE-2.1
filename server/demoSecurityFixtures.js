/**
 * Security-check fixtures mounted under /demo/security.
 *
 * Two variants per check, so the security checks can be validated against a
 * known-safe and an intentionally-vulnerable target — the honest-reporting
 * contract demands the check fail on the vulnerable variant and pass (or
 * honestly report not-tested) on the safe one:
 *
 *   /demo/security/safe/...      — behaves securely
 *   /demo/security/vulnerable/...— exhibits exactly one intentional flaw per check
 *
 * Everything is in-memory, non-destructive, and isolated from the practice
 * site's own routes above.
 */

const USERS = {
	'alice@fixture.test': { password: 'alice-pass-1', role: 'admin', id: 'u1' },
	'bob@fixture.test': { password: 'bob-pass-2', role: 'viewer', id: 'u2' }
};

const RECORDS = {
	u1: [{ id: 'r1', title: 'Alice invoice #001' }, { id: 'r2', title: 'Alice invoice #002' }],
	u2: [{ id: 'r3', title: 'Bob invoice #003' }]
};

export function mountSecurityFixtures(router) {
	const secureSessions = new Map(); // token -> email
	const weakSessions = new Map(); // token -> email
	// Vulnerable variant: sessions survive logout (no invalidation).
	const persistingSessions = new Map();

	const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
	body { font: 14px/1.6 system-ui, sans-serif; margin: 0; background: #f6f7fb; color: #1a1d24; }
	header { background: #fff; border-bottom: 1px solid #e3e6ee; padding: 12px 24px; display: flex; gap: 16px; align-items: center; }
	main { max-width: 640px; margin: 32px auto; background: #fff; border: 1px solid #e3e6ee; border-radius: 10px; padding: 24px; }
	h1 { margin-top: 0; font-size: 19px; }
	label { display: block; margin-bottom: 12px; font-size: 13px; }
	label span { display: block; margin-bottom: 4px; font-weight: 600; }
	input { width: 100%; padding: 8px 10px; border: 1px solid #ccd2e0; border-radius: 6px; font-size: 13px; box-sizing: border-box; }
	button { background: #3355cc; color: #fff; border: 0; border-radius: 6px; padding: 9px 16px; font-size: 13px; cursor: pointer; }
	.err { background: #fdecec; border: 1px solid #f5c2c2; color: #a11; padding: 8px 10px; border-radius: 6px; margin-bottom: 12px; font-size: 13px; }
	.ok { background: #e9f7ee; border: 1px solid #b6e2c6; color: #157347; padding: 8px 10px; border-radius: 6px; margin-bottom: 12px; font-size: 13px; }
	.card { border: 1px solid #e3e6ee; border-radius: 8px; padding: 12px; margin-bottom: 10px; }
	a { color: #3355cc; }
</style></head><body>${body}</body></html>`;

	const loginForm = (action, error = '') => `<main>
	<h1>Sign in</h1>${error}
	<form method="post" action="${action}">
		<label><span>Email</span><input name="email" type="email"></label>
		<label><span>Password</span><input name="password" type="password"></label>
		<button type="submit">Sign in</button>
	</form></main>`;

	const authed = (store, request) => {
		const email = store.get(request.headers.cookie?.match(/fixture_session=([^;]+)/)?.[1]);
		return email ? { email, ...USERS[email] } : undefined;
	};

	const setUser = (response, store, email) => {
		const token = Math.random().toString(36).slice(2);
		store.set(token, email);
		response.setHeader('Set-Cookie', `fixture_session=${token}; Path=/demo; HttpOnly`);
	};

	// ── Shared index ─────────────────────────────────────────────────────────
	router.get('/security', (_request, response) => {
		response.send(page('Security fixtures', `<main>
			<h1>Security test fixtures</h1>
			<div class="card"><b><a href="/demo/security/safe">Safe variants</a></b> — behave securely; security checks should pass or honestly report not-tested.</div>
			<div class="card"><b><a href="/demo/security/vulnerable">Vulnerable variants</a></b> — one intentional flaw per check; security checks must file findings.</div>
			<p>Accounts: alice@fixture.test / alice-pass-1 (admin) · bob@fixture.test / bob-pass-2 (viewer)</p>
		</main>`));
	});

	for (const [variant, isSafe] of [['safe', true], ['vulnerable', false]]) {
		const base = `/demo/security/${variant}`;
		const sessions = isSafe ? secureSessions : weakSessions;

		router.get(`/security/${variant}`, (_request, response) => {
			response.send(page(`Security fixtures — ${variant}`, `<main>
				<h1>${variant === 'safe' ? 'Safe' : 'Vulnerable'} fixtures</h1>
				<div class="card"><a href="${base}/auth">Authentication fixture</a></div>
				<div class="card"><a href="${base}/authz">Authorization fixture</a></div>
				<div class="card"><a href="${base}/input">Input validation fixture</a></div>
				<div class="card"><a href="${base}/sqli">SQL injection fixture</a></div>
			</main>`));
		});

		// ── Authentication ────────────────────────────────────────────────────
		router.post(`/security/${variant}/auth/login`, (request, response) => {
			const { email, password } = request.body ?? {};
			if (!email || !password || !USERS[email] || USERS[email].password !== password) {
				if (isSafe) {
					// Generic error, no user enumeration.
					response.redirect(`${base}/auth?error=1`);
					return;
				}
				// FLAW: reveals whether the account exists (user enumeration).
				const known = Boolean(USERS[email ?? '']);
				response.redirect(`${base}/auth?error=${known ? 'password' : 'user'}`);
				return;
			}
			setUser(response, isSafe ? sessions : persistingSessions, email);
			response.redirect(`${base}/auth/account`);
		});

		router.get(`/security/${variant}/auth`, (request, response) => {
			const messages = {
				'1': '<div class="err">Wrong email or password.</div>',
				password: '<div class="err">That password is incorrect for this account.</div>',
				user: '<div class="err">No account exists with that email.</div>'
			};
			response.send(page('Sign in', loginForm(`${base}/auth/login`, messages[request.query.error] ?? '')));
		});

		router.get(`/security/${variant}/auth/account`, (request, response) => {
			const store = isSafe ? sessions : persistingSessions;
			const user = authed(store, request);
			if (!user) {
				response.redirect(`${base}/auth`);
				return;
			}
			response.send(page('Your account', `<main>
				<h1>Signed in as ${user.email}</h1>
				<div class="card">Role: ${user.role}</div>
				<p><a href="${base}/auth/logout">Sign out</a></p>
			</main>`));
		});

		router.get(`/security/${variant}/auth/logout`, (request, response) => {
			const store = isSafe ? sessions : persistingSessions;
			const token = request.headers.cookie?.match(/fixture_session=([^;]+)/)?.[1];
			if (isSafe && token) {
				// Secure: the session is destroyed server-side.
				store.delete(token);
			}
			// Vulnerable variant: cookie is cleared client-side but the session
			// token remains valid server-side (no invalidation on logout).
			response.setHeader('Set-Cookie', 'fixture_session=; Path=/demo; Max-Age=0');
			response.redirect(`${base}/auth`);
		});

		// ── Authorization ─────────────────────────────────────────────────────
		router.get(`/security/${variant}/authz/login`, (request, response) => {
			const email = String(request.query.as ?? '');
			if (!USERS[email]) {
				response.redirect(`${base}/authz`);
				return;
			}
			setUser(response, sessions, email);
			response.redirect(`${base}/authz/records`);
		});

		router.get(`/security/${variant}/authz`, (_request, response) => {
			response.send(page('Authorization fixture', `<main>
				<h1>Pick an account</h1>
				<div class="card"><a href="${base}/authz/login?as=alice@fixture.test">Sign in as Alice (admin)</a></div>
				<div class="card"><a href="${base}/authz/login?as=bob@fixture.test">Sign in as Bob (viewer)</a></div>
			</main>`));
		});

		router.get(`/security/${variant}/authz/records`, (request, response) => {
			const user = authed(sessions, request);
			if (!user) {
				response.redirect(`${base}/auth`);
				return;
			}
			response.send(page('Records', `<main>
				<h1>${user.email}'s records</h1>
				${RECORDS[user.id].map(record => `<div class="card">${record.title} — <a href="${base}/authz/records/${record.id}">open</a></div>`).join('')}
				<p class="card">Try Bob's record directly: <a href="${base}/authz/records/r3">record r3</a></p>
			</main>`));
		});

		router.get(`/security/${variant}/authz/records/:id`, (request, response) => {
			const user = authed(sessions, request);
			if (!user) {
				response.redirect(`${base}/auth`);
				return;
			}
			const record = Object.entries(RECORDS).flatMap(([, list]) => list).find(item => item.id === request.params.id);
			if (!record) {
				response.status(404).send(page('Not found', '<main><h1>404 — Not found</h1></main>'));
				return;
			}
			if (!isSafe) {
				// FLAW: no ownership check — any signed-in user can open any
				// record by id (IDOR).
				response.send(page(record.title, `<main><h1>${record.title}</h1><div class="card">Owner check skipped (vulnerable variant).</div></main>`));
				return;
			}
			const owns = RECORDS[user.id].some(item => item.id === record.id);
			if (!owns) {
				response.status(403).send(page('Forbidden', '<main><h1>403 — Forbidden</h1><p>This record belongs to another user.</p></main>'));
				return;
			}
			response.send(page(record.title, `<main><h1>${record.title}</h1></main>`));
		});

		// ── Input validation ──────────────────────────────────────────────────
		router.get(`/security/${variant}/input`, (_request, response) => {
			response.send(page('Input validation fixture', `<main>
				<h1>Feedback form</h1>
				<form method="post" action="${base}/input/submit">
					<label><span>Message</span><input name="message" maxlength="200"></label>
					<label><span>Quantity</span><input name="quantity" type="number"></label>
					<button type="submit">Send</button>
				</form>
			</main>`));
		});

		router.post(`/security/${variant}/input/submit`, (request, response) => {
			const { message, quantity } = request.body ?? {};
			if (isSafe) {
				// Secure: bounded, type-checked, generic rejection.
				if (typeof message !== 'string' || message.trim().length === 0 || message.length > 200) {
					response.status(400).send(page('Rejected', '<main><h1>Message must be 1–200 characters.</h1></main>'));
					return;
				}
				const parsed = Number(quantity);
				if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
					response.status(400).send(page('Rejected', '<main><h1>Quantity must be a whole number from 1 to 100.</h1></main>'));
					return;
				}
				response.send(page('Thanks', '<main><h1>Received.</h1><div class="ok">Your feedback was recorded.</div></main>'));
				return;
			}
			// FLAW: unvalidated — crashes on missing input, echoes raw input
			// back into the page unchanged (no escaping, no type checks).
			try {
				if (message === undefined || quantity === undefined) {
					throw new TypeError("Cannot read properties of undefined (reading 'length')");
				}
				const doubled = quantity * 2;
				response.send(page('Thanks', `<main><h1>Received.</h1><div class="ok">You said: ${message} (doubled: ${doubled})</div></main>`));
			} catch (error) {
				response.status(500).send(page('Error', `<main><h1>500 — Internal Server Error</h1><pre>${error.stack}</pre></main>`));
			}
		});

		// ── SQL injection (simulated query behavior, no real database) ────────
		router.get(`/security/${variant}/sqli`, (_request, response) => {
			response.send(page('SQL injection fixture', `<main>
				<h1>Product lookup</h1>
				<form method="get" action="${base}/sqli/search">
					<label><span>SKU</span><input name="sku" placeholder="wgt-a"></label>
					<button type="submit">Look up</button>
				</form>
			</main>`));
		});

		const CATALOG = [
			{ sku: 'wgt-a', name: 'Widget A', price: '9.99' },
			{ sku: 'wgt-b', name: 'Widget B', price: '19.99' }
		];

		router.get(`/security/${variant}/sqli/search`, (request, response) => {
			const sku = String(request.query.sku ?? '');
			if (isSafe) {
				// Secure: exact-match lookup, input never changes query shape.
				const found = CATALOG.find(item => item.sku === sku);
				response.send(page('Lookup', `<main><h1>${found ? `${found.name} — £${found.price}` : 'No product with that SKU.'}</h1></main>`));
				return;
			}
			// FLAW: string-concatenated "query" — classic ' OR '1'='1 returns
			// everything, and a quote crashes with the "SQL" text.
			if (sku.includes("'")) {
				if (/' OR '1'='1/.test(sku)) {
					response.send(page('Lookup', `<main><h1>All products</h1>${CATALOG.map(item => `<div class="card">${item.name} — £${item.price}</div>`).join('')}</main>`));
					return;
				}
				response.status(500).send(page('Error', `<main><h1>500 — Internal Server Error</h1><pre>SqlError: unterminated quoted string at or near "${sku}"</pre></main>`));
				return;
			}
			const found = CATALOG.find(item => item.sku === sku);
			response.send(page('Lookup', `<main><h1>${found ? `${found.name} — £${found.price}` : 'No product with that SKU.'}</h1></main>`));
		});
	}
}
