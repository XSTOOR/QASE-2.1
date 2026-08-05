import express from 'express';

/**
 * A deliberately broken practice site, mounted at /demo.
 *
 * It exists so a run can be tried end to end — including the login wall and the
 * credential handoff — without pointing an autonomous agent at somebody else's
 * website. Every defect below is intentional.
 *
 *   sign in with  demo@qase.dev  /  demo1234
 */

const CREDENTIALS = { email: 'demo@qase.dev', password: 'demo1234' };

const shell = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
	body { font: 15px/1.6 system-ui, sans-serif; margin: 0; background: #f6f7fb; color: #1a1d24; }
	header { background: #fff; border-bottom: 1px solid #e3e6ee; padding: 14px 28px; display: flex; gap: 20px; align-items: center; }
	header b { font-size: 17px; }
	nav a { color: #3355cc; text-decoration: none; margin-right: 16px; font-size: 14px; }
	main { max-width: 720px; margin: 36px auto; background: #fff; border: 1px solid #e3e6ee; border-radius: 10px; padding: 28px; }
	h1 { margin-top: 0; font-size: 22px; }
	label { display: block; margin-bottom: 14px; font-size: 14px; }
	label span { display: block; margin-bottom: 5px; font-weight: 600; }
	input, select { width: 100%; padding: 9px 11px; border: 1px solid #ccd2e0; border-radius: 7px; font-size: 14px; box-sizing: border-box; }
	button { background: #3355cc; color: #fff; border: 0; border-radius: 7px; padding: 10px 18px; font-size: 14px; cursor: pointer; }
	.err { background: #fdecec; border: 1px solid #f5c2c2; color: #a11; padding: 10px 12px; border-radius: 7px; margin-bottom: 16px; font-size: 14px; }
	.card { border: 1px solid #e3e6ee; border-radius: 8px; padding: 14px; margin-bottom: 12px; }
	.muted { color: #6a7285; font-size: 13px; }
</style></head><body>${body}</body></html>`;

const nav = `<header><b>Acme Widgets</b><nav>
	<a href="/demo/app">Dashboard</a>
	<a href="/demo/app/search">Search</a>
	<a href="/demo/app/settings">Settings</a>
	<a href="/demo/app/help">Help</a>
	<a href="/demo/logout">Sign out</a>
</nav></header>`;

function authed(sessions, request) {
	return sessions.has(request.headers.cookie?.match(/demo_session=([^;]+)/)?.[1]);
}

export function mountDemoSite(app) {
	const demo = express.Router();
	const sessions = new Set();
	demo.use(express.urlencoded({ extended: false }));

	demo.get('/', (_request, response) => response.redirect('/demo/login'));

	demo.get('/login', (request, response) => {
		const error = request.query.error
			? `<div class="err">${request.query.error === 'server' ? 'Something went wrong (500).' : 'Wrong email or password.'}</div>`
			: '';
		response.send(shell('Sign in — Acme Widgets', `<main>
			<h1>Sign in</h1>${error}
			<form method="post" action="/demo/login">
				<label><span>Email</span><input name="email" type="email" placeholder="you@example.com"></label>
				<label><span>Password</span><input name="password" type="password" placeholder="Password"></label>
				<button type="submit">Sign in</button>
			</form>
			<p class="muted">Practice account: demo@qase.dev / demo1234</p>
		</main>`));
	});

	demo.post('/login', (request, response) => {
		const { email, password } = request.body;

		// BUG (critical): an empty password crashes the handler instead of
		// failing validation.
		if (!password) {
			response.status(500).send(shell('Error', '<main><h1>500 — Internal Server Error</h1><pre>TypeError: Cannot read properties of undefined (reading \'length\')</pre></main>'));
			return;
		}
		if (email !== CREDENTIALS.email || password !== CREDENTIALS.password) {
			response.redirect('/demo/login?error=1');
			return;
		}
		const token = Math.random().toString(36).slice(2);
		sessions.add(token);
		response.setHeader('Set-Cookie', `demo_session=${token}; Path=/demo; HttpOnly`);
		response.redirect('/demo/app');
	});

	demo.get('/logout', (_request, response) => {
		response.setHeader('Set-Cookie', 'demo_session=; Path=/demo; Max-Age=0');
		response.redirect('/demo/login');
	});

	demo.use('/app', (request, response, next) => {
		if (!authed(sessions, request)) {
			response.redirect('/demo/login');
			return;
		}
		next();
	});

	demo.get('/app', (_request, response) => {
		// BUG (medium): a script error on every dashboard load, and an image
		// that 404s.
		response.send(shell('Dashboard — Acme Widgets', `${nav}<main>
			<h1>Dashboard</h1>
			<div class="card"><b>Orders</b><div class="muted">128 this week</div></div>
			<div class="card"><b>Revenue</b><div class="muted">£12,480</div></div>
			<img src="/demo/img/chart.png" alt="Revenue chart" width="240">
			<p><a href="/demo/app/reports">Open the full report</a></p>
			<script>window.analytics.track('dashboard_view');</script>
		</main>`));
	});

	demo.get('/app/search', (request, response) => {
		const query = request.query.q;
		// BUG (high): a query longer than 20 characters throws a 500.
		if (typeof query === 'string' && query.length > 20) {
			response.status(500).send(shell('Error', '<main><h1>500 — Internal Server Error</h1><pre>RangeError: query too long</pre></main>'));
			return;
		}
		const results = query
			? `<p class="muted">${query.trim() === '' ? 'Showing all 340 products' : `2 results for “${query}”`}</p>
			   <div class="card">Widget A</div><div class="card">Widget B</div>`
			: '';
		response.send(shell('Search — Acme Widgets', `${nav}<main>
			<h1>Search</h1>
			<form method="get" action="/demo/app/search">
				<label><span>Query</span><input name="q" value="${(query ?? '').replace(/"/g, '&quot;')}"></label>
				<button type="submit">Search</button>
			</form>${results}
		</main>`));
	});

	demo.get('/app/settings', (_request, response) => {
		// BUG (high): the save button is not inside the form, so nothing saves.
		response.send(shell('Settings — Acme Widgets', `${nav}<main>
			<h1>Settings</h1>
			<form method="post" action="/demo/app/settings">
				<label><span>Display name</span><input name="name" value="Demo User"></label>
				<label><span>Timezone</span><select name="tz"><option>UTC</option><option>Europe/London</option></select></label>
			</form>
			<button type="button">Save changes</button>
			<p class="muted">Changes apply immediately.</p>
		</main>`));
	});

	demo.get('/app/help', (_request, response) => {
		// BUG (medium): the support link is broken.
		response.send(shell('Help — Acme Widgets', `${nav}<main>
			<h1>Help</h1>
			<p><a href="/demo/app/support">Contact support</a> — we reply within a day.</p>
			<p><a href="/demo/app/search">Search the docs</a></p>
		</main>`));
	});

	demo.get('/app/reports', (_request, response) => {
		response.status(404).send(shell('Not found', `${nav}<main><h1>404 — Not found</h1></main>`));
	});

	demo.use((_request, response) => {
		response.status(404).send(shell('Not found', '<main><h1>404 — Not found</h1></main>'));
	});

	app.use('/demo', demo);
}
