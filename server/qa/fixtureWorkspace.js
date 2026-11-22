/**
 * "Projectly" — a small multi-page project-management app inside the QA Lab,
 * built to prove that the QA engine explores an unfamiliar product, signs in
 * with authorized credentials, finds protected functionality, replans and
 * detects seeded defects. Nothing here is referenced by the engine: the engine
 * must discover all of it.
 *
 * Sign-in is two-step (email, then password) and only reachable through a
 * "Log in" link, so a password field never appears on the landing page.
 * Sessions expire after SESSION_HITS authenticated page loads, so the engine
 * must notice the redirect to sign-in and sign in again.
 */
import { randomUUID } from 'node:crypto';

export const WORKSPACE_ACCOUNTS = Object.freeze({
	user: { email: 'tester@projectly.test', password: 'projectly-pass', role: 'member' },
	admin: { email: 'admin@projectly.test', password: 'projectly-admin', role: 'admin' }
});

/** What the engine is expected to find in the workspace, by detector or check. */
export const WORKSPACE_DEFECTS = [
	{ id: 'ws_overlap', check: 'page.text_overlap', where: '/workspace/app' },
	{ id: 'ws_api_500', check: 'page.failed_request', where: '/workspace/app (stats API)' },
	{ id: 'ws_pagination_500', check: 'page.http_error_page', where: '/workspace/app/projects?page=3' },
	{ id: 'ws_search_xss', check: 'security.reflected_xss', where: '/workspace/app/projects?q=' },
	{ id: 'ws_public_reports', check: 'authz.protected_page_public', where: '/workspace/app/reports' },
	{ id: 'ws_upload_validation', check: 'forms.no_validation', where: '/workspace/app/projects/new' }
];

const SESSION_HITS = Number(process.env.QASE_LAB_SESSION_HITS) || 30;
const sessions = new Map();
const PROJECTS = Array.from({ length: 23 }, (_, i) => ({
	id: i + 1,
	name: ['Atlas', 'Beacon', 'Cobalt', 'Delta', 'Ember', 'Flux', 'Granite', 'Harbor'][i % 8] + ` ${Math.floor(i / 8) + 1}`,
	status: ['active', 'paused', 'done'][i % 3],
	owner: ['Asha', 'Ben', 'Chen', 'Dara'][i % 4]
}));

const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const shell = (title, body, { signedIn = false, head = '' } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — Projectly</title>
<meta name="description" content="Projectly keeps small teams' projects on track.">
<style>
body{font-family:system-ui,sans-serif;margin:0;color:#111;background:#fff}
.top{display:flex;gap:18px;align-items:center;padding:12px 20px;background:#0f172a;color:#fff}
.top a{color:#e2e8f0;text-decoration:none}
.top .brand{font-weight:700;margin-right:auto;color:#fff}
main{padding:24px;max-width:1000px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:8px;text-align:left}
.btn{display:inline-block;padding:8px 14px;background:#2563eb;color:#fff;border:0;border-radius:6px;font-size:15px;text-decoration:none}
.pager a{margin-right:8px}
</style>${head}</head><body>
<nav class="top" aria-label="Main"><a class="brand" href="/workspace/">Projectly</a>${signedIn
		? '<a href="/workspace/app">Dashboard</a><a href="/workspace/app/projects">Projects</a><a href="/workspace/app/reports">Reports</a><a href="/workspace/app/admin">Admin</a><a href="/workspace/logout">Log out</a>'
		: '<a href="/workspace/pricing">Pricing</a><a href="/workspace/login">Log in</a>'}</nav>
<main>${body}</main></body></html>`;

function sessionFor(request) {
	const token = /wsauth=([\w-]+)/.exec(request.headers.cookie ?? '')?.[1];
	const entry = token && sessions.get(token);
	if (!entry) return undefined;
	entry.hits++;
	if (entry.hits > SESSION_HITS) { sessions.delete(token); return { expired: true }; }
	return entry;
}

function readForm(request) {
	return new Promise(resolve => {
		if (request.body && typeof request.body === 'object') return resolve(new URLSearchParams(request.body));
		let body = '';
		request.on('data', chunk => { body += chunk; });
		request.on('end', () => resolve(new URLSearchParams(body)));
	});
}

/**
 * "/workspace/spa": a single-page app whose session lives only in sessionStorage
 * (no cookie). Its pages bounce to sign-in when the tab has no token, which is how
 * many SPAs behave. Signing in must carry sessionStorage into new tabs.
 */
const SPA_GUARD = `<script>if (!sessionStorage.getItem('spa_token')) location.replace('/workspace/spa/login');</script>`;
function spaPage(title, body) {
	return shell(title, `${SPA_GUARD}<div id="app">${body}</div>`, { head: '' }).replace('<nav class="top" aria-label="Main">', '<nav class="top" aria-label="Main"><a href="/workspace/spa/app">Home</a><a href="/workspace/spa/app/settings">Settings</a><a href="/workspace/spa/app/billing">Billing</a>');
}

/** Handles /workspace/*. Returns true when the request was handled. */
export async function workspaceHandler(request, response, path, url) {
	if (!path.startsWith('/workspace')) return false;
	const html = (body, status = 200, headers = {}) => { response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers }); response.end(body); };
	const redirect = (location, headers = {}) => { response.writeHead(302, { Location: location, ...headers }); response.end(); };
	const needAuth = () => {
		const session = sessionFor(request);
		if (!session || session.expired) { redirect(`/workspace/login?next=${encodeURIComponent(path + url.search)}${session?.expired ? '&expired=1' : ''}`); return undefined; }
		return session;
	};
	switch (path) {
		case '/workspace/spa/login':
			html(shell('Sign in', `<h1>Welcome back</h1><form id="f"><label>Email <input type="email" name="email" autocomplete="username" required></label><label>Password <input type="password" name="password" required></label><button class="btn" type="submit">Sign in</button></form><p role="alert" id="err"></p>
<script>document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); const d = new FormData(e.target);
if (d.get('email') === ${JSON.stringify(WORKSPACE_ACCOUNTS.user.email)} && d.get('password') === ${JSON.stringify(WORKSPACE_ACCOUNTS.user.password)}) { sessionStorage.setItem('spa_token', 'tok-' + Date.now()); location.href = '/workspace/spa/app'; }
else document.getElementById('err').textContent = 'Invalid email or password.'; });</script>`));
			return true;
		case '/workspace/spa/app':
			html(spaPage('Home', '<h1>Your projects</h1><p>3 active projects.</p><p><a href="/workspace/spa/app/settings">Account settings</a></p>'));
			return true;
		case '/workspace/spa/app/settings':
			html(spaPage('Settings', '<h1>Account settings</h1><form><label>Display name <input name="name"></label><button class="btn" type="button">Save</button></form>'));
			return true;
		case '/workspace/spa/app/billing':
			html(spaPage('Billing', '<h1>Billing</h1><table><tr><th>Plan</th><td>Team</td></tr></table>'));
			return true;
		case '/workspace': return redirect('/workspace/'), true;
		case '/workspace/':
			html(shell('Projects without chaos', `<h1>Projects without chaos</h1><p>Plan, track and ship work with your team.</p><p><a class="btn" href="/workspace/login">Log in</a> <a href="/workspace/pricing">See pricing</a></p>`));
			return true;
		case '/workspace/pricing':
			html(shell('Pricing', '<h1>Pricing</h1><ul><li>Starter — free for 3 projects</li><li>Team — $9 per user per month</li></ul>'));
			return true;
		case '/workspace/login': {
			if (request.method === 'POST') {
				const form = await readForm(request);
				const account = Object.values(WORKSPACE_ACCOUNTS).find(item => item.email === form.get('email') && item.password === form.get('password'));
				if (!account) { html(shell('Sign in', `<h1>Enter your password</h1><p role="alert">That password is not correct.</p>${passwordForm(form.get('email') ?? '', form.get('next') ?? '')}`), 401); return true; }
				const token = randomUUID();
				sessions.set(token, { role: account.role, email: account.email, hits: 0 });
				redirect(form.get('next') && form.get('next').startsWith('/workspace/') ? form.get('next') : '/workspace/app', { 'Set-Cookie': `wsauth=${token}; Path=/; HttpOnly; SameSite=Lax` });
				return true;
			}
			// Step 1: email only, "Continue" leads to the password step.
			const next = url.searchParams.get('next') ?? '';
			html(shell('Sign in', `<h1>Sign in to Projectly</h1>${url.searchParams.get('expired') ? '<p role="status">Your session expired. Please sign in again.</p>' : ''}
<form method="get" action="/workspace/login/password"><label>Work email <input name="email" type="email" autocomplete="username" required></label><input type="hidden" name="next" value="${escape(next)}"> <button class="btn" type="submit">Continue</button></form>`));
			return true;
		}
		case '/workspace/login/password':
			html(shell('Sign in', `<h1>Enter your password</h1>${passwordForm(url.searchParams.get('email') ?? '', url.searchParams.get('next') ?? '')}`));
			return true;
		case '/workspace/logout': {
			const token = /wsauth=([\w-]+)/.exec(request.headers.cookie ?? '')?.[1];
			if (token) sessions.delete(token);
			redirect('/workspace/', { 'Set-Cookie': 'wsauth=; Path=/; Max-Age=0' });
			return true;
		}
		case '/workspace/api/stats':
			response.writeHead(500, { 'Content-Type': 'application/json' }); response.end('{"error":"stats unavailable"}');
			return true;
		case '/workspace/app': {
			const session = needAuth(); if (!session) return true;
			// Seeded: the "Beta" badge sits on top of the heading; the stats API fails; a spinner never stops.
			html(shell('Dashboard', `<div style="position:relative;height:70px"><h1 style="position:absolute;top:0;left:0;margin:0;font-size:32px">Team dashboard overview</h1><span style="position:absolute;top:8px;left:120px;font-size:22px;background:#fde68a;padding:2px 8px">Beta workspace</span></div>
<p>Signed in as ${escape(session.email)} (${session.role}).</p><p id="stats">Loading stats…</p>
<p><a class="btn" href="/workspace/app/projects/new">New project</a> <a href="/workspace/app/projects">All projects</a></p>
<script>fetch('/workspace/api/stats').then(r => r.json()).then(d => { document.getElementById('stats').textContent = d.open + ' open projects'; }).catch(() => {});</script>`, { signedIn: true }));
			return true;
		}
		case '/workspace/app/projects': {
			const session = needAuth(); if (!session) return true;
			const q = url.searchParams.get('q') ?? '';
			const status = url.searchParams.get('status') ?? '';
			const sort = url.searchParams.get('sort') ?? '';
			const page = Number(url.searchParams.get('page') ?? 1) || 1;
			// Seeded: the last page of results crashes the server.
			if (page >= 3) { html(shell('Error', '<h1>Something went wrong</h1><p>Internal server error.</p>', { signedIn: true }), 500); return true; }
			let rows = PROJECTS.filter(item => (!q || item.name.toLowerCase().includes(q.toLowerCase())) && (!status || item.status === status));
			if (sort === 'name') rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
			const pageRows = rows.slice((page - 1) * 10, page * 10);
			const query = (patch) => { const p = new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), ...(sort ? { sort } : {}), page: String(page), ...patch }); return `?${p}`; };
			// Seeded: the search term is echoed without escaping.
			html(shell('Projects', `<h1>Projects</h1>
<form role="search" method="get"><label>Search projects <input type="search" name="q" value="${escape(q)}"></label>
<label>Status <select name="status"><option value="">Any</option>${['active', 'paused', 'done'].map(s => `<option value="${s}"${s === status ? ' selected' : ''}>${s}</option>`).join('')}</select></label>
<button class="btn" type="submit">Apply</button></form>
<p>${q ? `Results for ${q}` : 'All projects'} · ${rows.length} found</p>
<table><thead><tr><th><a href="${query({ sort: 'name', page: '1' })}">Name</a></th><th>Status</th><th>Owner</th></tr></thead><tbody>
${pageRows.map(item => `<tr><td>${escape(item.name)}</td><td>${item.status}</td><td>${item.owner}</td></tr>`).join('') || '<tr><td colspan="3">No projects match.</td></tr>'}
</tbody></table>
<nav class="pager" aria-label="Pagination">${page > 1 ? `<a href="${query({ page: String(page - 1) })}">Previous</a>` : ''}${[1, 2, 3].map(n => `<a href="${query({ page: String(n) })}"${n === page ? ' aria-current="page"' : ''}>${n}</a>`).join('')}<a href="${query({ page: String(page + 1) })}">Next</a></nav>`, { signedIn: true }));
			return true;
		}
		case '/workspace/app/projects/new': {
			const session = needAuth(); if (!session) return true;
			if (request.method === 'POST') { html(shell('Created', '<h1>Project created</h1>', { signedIn: true })); return true; }
			// Seeded: no required fields, no client-side validation, a file input with no type limit.
			html(shell('New project', `<h1>New project</h1><form method="post" action="/workspace/app/projects/new" enctype="multipart/form-data" novalidate>
<label>Project name <input name="name"></label><br><label>Owner email <input name="owner" type="text"></label><br>
<label>Brief (PDF) <input name="brief" type="file"></label><br><label>Start date <input name="start" type="date"></label><br>
<button class="btn" type="submit">Create project</button></form>`, { signedIn: true }));
			return true;
		}
		case '/workspace/app/reports':
			// Seeded: this page skips the session check, so anyone can read it signed out.
			html(shell('Reports', '<h1>Quarterly reports</h1><p>Revenue by project: Atlas 1 — $12,400 · Beacon 1 — $8,900</p>', { signedIn: true }));
			return true;
		case '/workspace/app/admin': {
			const session = needAuth(); if (!session) return true;
			if (session.role !== 'admin') { html(shell('Forbidden', '<h1>Admins only</h1><p>You need the admin role to manage members.</p>', { signedIn: true }), 403); return true; }
			html(shell('Admin', '<h1>Members</h1><ul><li>Asha (admin)</li><li>Ben</li></ul>', { signedIn: true }));
			return true;
		}
		default:
			return false;
	}
}

function passwordForm(email, next) {
	return `<form method="post" action="/workspace/login"><input type="hidden" name="email" value="${escape(email)}"><input type="hidden" name="next" value="${escape(next)}">
<p>Signing in as <b>${escape(email)}</b></p><label>Password <input name="password" type="password" autocomplete="current-password" required></label> <button class="btn" type="submit">Sign in</button></form>`;
}
