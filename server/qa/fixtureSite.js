/**
 * QA Lab: a small site with seeded, realistic defects, used by the engine
 * tests and available at /demo/qa-lab outside production. Every defect is
 * listed in SEEDED_DEFECTS with the detector expected to find it, so detection
 * can be measured instead of assumed. /clean is a defect-free control page for
 * false-positive checks.
 */
import http from 'node:http';

export const SEEDED_DEFECTS = [
	{ id: 'overlap', detector: 'page.text_overlap', where: '/' },
	{ id: 'clipped', detector: 'page.text_clipped', where: '/' },
	{ id: 'obscured', detector: 'page.control_obscured', where: '/' },
	{ id: 'mobile_overflow', detector: 'page.horizontal_overflow', where: '/ (mobile)' },
	{ id: 'broken_image', detector: 'page.broken_image', where: '/' },
	{ id: 'alt', detector: 'page.image_alt_missing', where: '/' },
	{ id: 'contrast', detector: 'page.low_contrast', where: '/' },
	{ id: 'undefined', detector: 'page.broken_text', where: '/' },
	{ id: 'js_error', detector: 'page.page_error', where: '/' },
	{ id: 'api_500', detector: 'page.failed_request', where: '/' },
	{ id: 'cls', detector: 'page.layout_shift', where: '/' },
	{ id: 'reveal', detector: 'page.hidden_content', where: '/' },
	{ id: 'menu_behind', detector: 'motion.opens_behind', where: '/' },
	{ id: 'menu_offscreen', detector: 'motion.opens_offscreen', where: '/' },
	{ id: 'dead_button', detector: 'motion.dead_control', where: '/' },
	{ id: 'slow_accordion', detector: 'motion.slow_animation', where: '/' },
	{ id: 'dialog_escape', detector: 'motion.escape_does_not_close', where: '/' },
	{ id: 'reduced_motion', detector: 'motion.reduced_motion_ignored', where: '/' },
	{ id: 'broken_link', detector: 'links.broken', where: '/' },
	{ id: 'form_validation', detector: 'forms.no_validation', where: '/contact' },
	{ id: 'email', detector: 'forms.invalid_email_accepted', where: '/contact' },
	{ id: 'xss', detector: 'security.reflected_xss', where: '/search' },
	{ id: 'redirect', detector: 'security.open_redirect', where: '/login' },
	{ id: 'sql', detector: 'security.sql_error', where: '/product' },
	{ id: 'env', detector: 'security.exposed_file', where: '/.env' },
	{ id: 'git', detector: 'security.exposed_file', where: '/.git/HEAD' },
	{ id: 'csp', detector: 'security.csp_missing', where: 'headers' },
	{ id: 'clickjacking', detector: 'security.clickjacking', where: 'headers' },
	{ id: 'cookie', detector: 'security.cookie_flags', where: 'headers' },
	{ id: 'cors', detector: 'security.cors_reflection', where: 'headers' },
	{ id: 'secret', detector: 'security.client_secret', where: '/static/app.js' },
	{ id: 'version', detector: 'security.version_disclosure', where: 'headers' },
	{ id: 'jquery', detector: 'security.vulnerable_library', where: '/' }
];

const layout = (title, body, { head = '', lang = 'en' } = {}) => `<!doctype html><html${lang ? ` lang="${lang}"` : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;color:#111;background:#fff}
header{display:flex;gap:16px;align-items:center;padding:12px 20px;background:#f4f4f6;position:relative;z-index:1}
header a{color:#123}
main{padding:20px;max-width:1100px}
.btn{display:inline-block;padding:8px 14px;background:#2850d0;color:#fff;border:0;border-radius:6px;font-size:15px}
</style>${head}</head><body>${body}</body></html>`;

const HOME_HEAD = `<style>
.hero{position:relative;height:120px}
.hero h1{position:absolute;top:10px;left:0;margin:0;font-size:34px}
.hero .sub{position:absolute;top:22px;left:40px;margin:0;font-size:22px}
.cta-row{margin-top:20px}
.cta{width:90px;white-space:nowrap;overflow:hidden;display:inline-block;padding:8px;background:#2850d0;color:#fff;border-radius:6px}
.promo{position:relative;height:60px;margin-top:20px}
.promo button{position:absolute;left:0;top:0}
.promo .sticker{position:absolute;left:0;top:0;width:220px;height:50px;background:#ffe14d;display:flex;align-items:center;padding-left:120px;box-sizing:border-box}
.faded{color:#bbb}
.wide{width:900px;background:#eef;padding:10px}
#products-menu{display:none;position:absolute;top:100%;left:120px;background:#fff;border:1px solid #ccc;padding:10px;z-index:1;width:200px}
#products-menu.open{display:block}
.content-panel{position:relative;z-index:5;background:#fafafa;height:220px;padding:10px}
#side-menu{position:fixed;top:0;right:-140px;width:300px;height:200px;background:#fff;border:1px solid #333;display:none;z-index:50}
#side-menu.open{display:block}
.acc-body{height:0;overflow:hidden;transition:height 2.4s ease}
.acc-body.open{height:80px}
.reveal{opacity:0;transform:translateY(30px)}
.spinner{width:120px;height:120px;border:10px solid #2850d0;border-radius:50%;border-top-color:transparent;animation:spin 1.2s linear infinite;margin:20px 0}
@keyframes spin{to{transform:rotate(360deg)}}
.dialog{display:none;position:fixed;inset:20% 20%;background:#fff;border:2px solid #000;padding:20px;z-index:100}
.dialog.open{display:block}
</style>`;

const HOME = `<header><a href="/">Lab</a><button id="products-toggle" aria-expanded="false" aria-controls="products-menu">Products</button>
<div id="products-menu"><a href="/clean">Widgets</a><br><a href="/clean">Gadgets</a><br><a href="/clean">Gizmos</a></div>
<button id="menu-toggle" aria-expanded="false" aria-label="Open menu">☰ Menu</button><a href="/contact">Contact</a><a href="/search?q=widgets">Search</a><a href="/missing-page">Pricing</a><a href="/product?id=1">Top product</a><a href="/login">Sign in</a></header>
<div id="side-menu"><a href="/clean">Account</a><a href="/clean">Orders</a><a href="/clean">Settings</a></div>
<main>
<div class="content-panel"><p>Featured content panel that sits above the products dropdown.</p></div>
<section class="hero"><h1>Welcome to the QA Lab</h1><p class="sub">The fastest way to ship quality</p></section>
<div class="cta-row"><span class="cta">Start your free trial today</span></div>
<div class="promo"><button class="btn" id="claim">Claim offer</button><div class="sticker">Limited!</div></div>
<p class="faded">This light grey paragraph is hard to read for many users.</p>
<p>Price: <span id="price">$undefined</span> per month</p>
<img src="/static/missing.png" alt="Team photo" width="120" height="80"><img src="/static/pixel.png" width="60" height="60">
<div class="wide">This promotional strip has a fixed width of 900px and breaks small screens.</div>
<button type="button" class="btn" id="subscribe">Subscribe</button>
<h2>FAQ</h2><button id="acc" aria-expanded="false" class="btn">How does billing work?</button><div class="acc-body" id="acc-body"><p>Monthly, in advance.</p></div>
<button id="open-dialog" class="btn" aria-haspopup="dialog">Open details</button>
<div class="dialog" id="dialog" role="dialog" aria-modal="true"><p>Details dialog. There is no close button and Escape does nothing.</p><a href="/clean">Read more</a></div>
<div class="spinner" aria-hidden="false"></div>
<div style="height:1400px"></div>
<section class="reveal" id="testimonials"><h2>What customers say</h2><p>"QA Lab found every bug we planted."</p></section>
<div style="height:400px"></div>
</main>
<script src="/static/jquery-1.12.4.js"></script>
<script src="/static/app.js"></script>
<script>
document.getElementById('products-toggle').addEventListener('click', e => { const m = document.getElementById('products-menu'); m.classList.toggle('open'); e.currentTarget.setAttribute('aria-expanded', m.classList.contains('open')); });
document.getElementById('menu-toggle').addEventListener('click', e => { document.getElementById('side-menu').classList.toggle('open'); e.currentTarget.setAttribute('aria-expanded', 'true'); });
document.getElementById('acc').addEventListener('click', e => { document.getElementById('acc-body').classList.toggle('open'); e.currentTarget.setAttribute('aria-expanded', String(document.getElementById('acc-body').classList.contains('open'))); });
document.getElementById('open-dialog').addEventListener('click', () => document.getElementById('dialog').classList.add('open'));
setTimeout(() => { const b = document.createElement('div'); b.style.cssText = 'height:380px;background:#ffd;'; b.textContent = 'Late cookie banner pushing content down'; document.querySelector('.hero').before(b); }, 700);
fetch('/api/fail').then(r => r.json()).then(d => { document.getElementById('price').textContent = '$' + d.price.amount; }).catch(() => {});
window.lab.init();
</script>`;

const CLEAN = `<header><a href="/">Lab</a><a href="/clean">Clean page</a></header><main><h1>Clean page</h1>
<p>This page is intentionally well built: readable contrast, labelled controls, responsive layout.</p>
<details><summary>More information</summary><p>Hidden details that open instantly.</p></details>
<form action="/clean" method="get"><label for="name">Your name</label> <input id="name" name="name" required> <button class="btn" type="submit">Go</button></form>
<img src="/static/pixel.png" alt="Decorative dot" width="40" height="40">
<style>.pseudo-cta{position:relative;z-index:0;color:#fff;background:transparent;border:0;padding:12px 20px;font:600 16px system-ui}.pseudo-cta::before{content:"";position:absolute;inset:0;z-index:-1;background:#111;border-radius:8px}
.pw-wrap{position:relative;display:inline-block}.pw-wrap input{padding-right:40px;height:36px}.pw-eye{position:absolute;right:6px;top:6px;width:24px;height:24px;border:0;background:#fff;padding:0;cursor:pointer}
.handoff.busy::after{content:"";display:inline-block;width:12px;height:12px;margin-left:6px;border:2px solid #555;border-top-color:transparent;border-radius:50%;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style>
<p><button type="button" class="pseudo-cta" onclick="this.blur()">Get started</button></p>
<p><label for="pw">Password</label> <span class="pw-wrap"><input id="pw" type="password" autocomplete="current-password"><button type="button" class="pw-eye" aria-label="Show password" onclick="var f=document.getElementById('pw');f.type=f.type==='password'?'text':'password'">◉</button></span></p>
<p><button type="button" class="handoff" onclick="this.classList.add('busy');location.href='https://accounts.example.invalid/oauth'">Continue with Google</button> <button type="button" class="handoff" onclick="this.classList.add('busy');location.href='https://docs.example.invalid/'">Docs</button></p></main>`;

const CONTACT = `<header><a href="/">Lab</a></header><main><h1>Contact us</h1>
<form action="/contact" method="post" novalidate>
<label>Name <input name="name"></label><br>
<label>Email <input name="email" type="text"></label><br>
<label>Message <textarea name="message"></textarea></label><br>
<button class="btn" type="submit">Send</button></form></main>`;

// A fake, key-shaped value for the client-secret detector, assembled at runtime
// so the repository's own credential scan does not flag this file.
const FAKE_AWS_KEY = ['AKIA', 'QASELAB1', '23456789'].join('');

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');


/**
 * BrightPath Academy: a small education product for children with planted
 * compliance gaps, used to test compliance SQA end to end. Planted: an
 * analytics cookie set before consent, a cookie notice without a reject
 * option, a sign-up form collecting a child's data with no privacy notice,
 * a privacy policy that never mentions children or parental consent, no
 * accessibility statement, an image without alt text and low-contrast text.
 */
export const EDU_GAPS = ['privacy.tracking_before_consent', 'privacy.cookie_reject', 'privacy.form_notice', 'privacy.children_notice', 'privacy.accessibility_statement', 'a11y.images_alt', 'a11y.contrast'];
const EDU_NAV = '<header><a href="/edu/">BrightPath Academy</a><a href="/edu/courses">Courses</a><a href="/edu/parents">For parents</a><a href="/edu/about">About</a></header>';
const EDU_FOOTER = '<footer style="padding:20px"><a href="/edu/privacy">Privacy policy</a> · <a href="/edu/terms">Terms of use</a> · Contact: hello@brightpath.example</footer>';
const EDU_BANNER = '<div id="cookie-note" style="position:fixed;bottom:0;left:0;right:0;background:#222;color:#fff;padding:12px">We use cookies to improve your learning experience. <button class="btn">Accept</button></div>';
const EDU_PAGES = {
	'/edu/': `${EDU_NAV}<main><h1>Fun online courses for kids aged 8–14</h1><p>Live maths, coding and science classes with real teachers. Prices in ₹ and $. Students from India and the US learn with us.</p><img src="/static/pixel.png" width="120" height="80"><p style="color:#bbb">Classes for Grade 3 to Grade 9 students.</p>
<h2>Create your child's account</h2><form method="post" action="/edu/signup"><label>Child's name <input name="child_name"></label> <label>Child's age <input name="age" type="number"></label> <label>Parent email <input name="email" type="email"></label> <button class="btn">Start free trial</button></form></main>${EDU_FOOTER}${EDU_BANNER}`,
	'/edu/courses': `${EDU_NAV}<main><h1>Courses</h1><ul><li>Coding for kids (ages 8–11)</li><li>Maths Olympiad (ages 10–14)</li></ul></main>${EDU_FOOTER}`,
	'/edu/parents': `${EDU_NAV}<main><h1>For parents</h1><p>Track your child's progress in the parent dashboard.</p></main>${EDU_FOOTER}`,
	'/edu/about': `${EDU_NAV}<main><h1>About BrightPath</h1><p>BrightPath Academy is an online school for children, based in Bengaluru, India, teaching students in India and the United States.</p></main>${EDU_FOOTER}`,
	'/edu/privacy': `${EDU_NAV}<main><h1>Privacy policy</h1><p>We collect your name, email address and usage data to provide our services and improve them. We use analytics cookies. We may share data with service providers. You can contact us at hello@brightpath.example to access or delete your data. This policy was last updated in 2025.</p><p>${'We take security seriously and use industry-standard measures to protect information. '.repeat(6)}</p></main>${EDU_FOOTER}`,
	'/edu/terms': `${EDU_NAV}<main><h1>Terms of use</h1><p>By using BrightPath you agree to these terms.</p></main>${EDU_FOOTER}`
};

export function labHandler(request, response, { prefix = '' } = {}) {
	const url = new URL(request.url, 'http://lab');
	// Mounted under Express, the prefix is already stripped from request.url.
	const path = (prefix && url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname) || '/';
	const origin = request.headers.origin;
	response.setHeader('X-Powered-By', 'Express 4.17.1');
	if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Access-Control-Allow-Credentials', 'true'); }
	const html = (body, status = 200) => { response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(body); };
	const link = href => `${prefix}${href}`;
	const rewrite = text => prefix ? text.replace(/(href|src|action)="\//g, `$1="${prefix}/`).replace(/fetch\('\//g, `fetch('${prefix}/`) : text;
	switch (path) {
		case '/':
			response.setHeader('Set-Cookie', 'sessionid=lab-session-1234; Path=/');
			return html(rewrite(layout('QA Lab', HOME, { head: HOME_HEAD, lang: '' })));
		case '/clean': return html(rewrite(layout('Clean page', CLEAN)));
		case '/edu': response.writeHead(301, { Location: link('/edu/') }); return response.end();
		case '/edu/': case '/edu/courses': case '/edu/parents': case '/edu/about': case '/edu/privacy': case '/edu/terms':
			// The analytics cookie is set on first load, before the visitor answers the cookie notice.
			response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': '_ga=GA1.1.123456.789; Path=/; Max-Age=63072000' });
			return response.end(rewrite(layout(path === '/edu/' ? 'BrightPath Academy — online classes for kids' : `${path.split('/').pop()} — BrightPath Academy`, EDU_PAGES[path])));
		case '/contact':
			if (request.method === 'POST') return html(rewrite(layout('Thanks', '<main><h1>Thanks!</h1></main>')));
			return html(rewrite(layout('Contact', CONTACT)));
		case '/search': {
			const q = url.searchParams.get('q') ?? '';
			return html(rewrite(layout('Search', `<header><a href="/">Lab</a></header><main><h1>Search</h1><form><label for="q">Search</label> <input id="q" name="q" value="${q.replace(/"/g, '&quot;')}"> <button class="btn">Search</button></form><p>Results for ${q}</p></main>`)));
		}
		case '/login': {
			if (request.method === 'POST') {
				let body = '';
				request.on('data', chunk => { body += chunk; });
				request.on('end', () => {
					const form = new URLSearchParams(body);
					if (form.get('email') === 'qa@lab.test' && form.get('password') === 'lab-pass') {
						response.writeHead(302, { Location: link('/account'), 'Set-Cookie': 'labauth=ok; Path=/; HttpOnly' });
						return response.end();
					}
					html(rewrite(layout('Sign in', '<main><h1>Sign in</h1><p role="alert">Wrong email or password.</p><form method="post" action="/login"><label>Email <input name="email" type="email" required></label> <label>Password <input name="password" type="password" required></label> <button class="btn">Sign in</button></form></main>')), 401);
				});
				return;
			}
			const next = url.searchParams.get('next');
			if (next) { response.writeHead(302, { Location: next }); return response.end(); }
			return html(rewrite(layout('Sign in', '<header><a href="/">Lab</a></header><main><h1>Sign in</h1><form method="post" action="/login"><label>Email <input name="email" type="email" required></label> <label>Password <input name="password" type="password" required></label> <button class="btn">Sign in</button></form></main>')));
		}
		case '/product': {
			const id = url.searchParams.get('id') ?? '1';
			if (id.includes("'")) return html(`<pre>SQLSTATE[42000]: Syntax error or access violation: 1064 You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near ''' at line 1</pre>`, 500);
			return html(rewrite(layout('Product', `<header><a href="/">Lab</a></header><main><h1>Product ${Number(id) || 1}</h1><p>A fine widget.</p></main>`)));
		}
		case '/app-login':
			// A single-page-app sign-in like many real products: JavaScript posts JSON to an
			// auth API (slowly), shows the API's error inline, and redirects on success.
			return html(rewrite(layout('Sign in', `<main><h1>Welcome back.</h1><p id="err" role="alert" hidden></p><form id="f"><input id="email" type="email" placeholder="Email Address" required>
<span style="position:relative;display:inline-block"><input id="password" type="password" placeholder="Password" required><button type="button" tabindex="-1" aria-label="Show password" style="position:absolute;right:4px;top:2px">◉</button></span>
<button type="submit">Sign In</button></form>
<script>document.getElementById('f').addEventListener('submit', async event => { event.preventDefault(); const err = document.getElementById('err'); err.hidden = true;
try { const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: document.getElementById('email').value, password: document.getElementById('password').value }) });
if (r.ok) { setTimeout(() => { location.href = '${link('/account')}'; }, 300); } else { err.textContent = 'Invalid email or password.'; err.hidden = false; } } catch (e) { err.textContent = e.message; err.hidden = false; } });</script></main>`)));
		case '/api/auth/login': {
			if (request.method !== 'POST') { response.writeHead(405); return response.end(); }
			let body = '';
			const answer = () => setTimeout(() => {
				let data = request.body && typeof request.body === 'object' ? request.body : {};
				if (body) { try { data = JSON.parse(body); } catch { /* invalid body is a failed sign-in */ } }
				const ok = data.email === 'qa@lab.test' && data.password === 'lab-pass';
				response.writeHead(ok ? 200 : 401, { 'content-type': 'application/json', ...(ok ? { 'Set-Cookie': 'labauth=ok; Path=/; HttpOnly' } : {}) });
				response.end(JSON.stringify(ok ? { ok: true } : { error: 'invalid_credentials' }));
			}, 2500);
			// Mounted inside the dashboard, express.json() has already read the body.
			if (request.readableEnded || request.body) return answer();
			request.on('data', chunk => { body += chunk; });
			request.on('end', answer);
			return;
		}
		case '/account':
			if (!/labauth=ok/.test(request.headers.cookie ?? '')) { response.writeHead(302, { Location: link('/login') }); return response.end(); }
			return html(rewrite(layout('Account', '<header><a href="/">Lab</a><a href="/account">Account</a></header><main><h1>Account dashboard</h1><p>Open orders: <b>NaN</b></p><p>Signed in as qa@lab.test</p></main>')));
		case '/api/fail': response.writeHead(500, { 'Content-Type': 'application/json' }); return response.end('{"error":"boom"}');
		case '/.env': response.writeHead(200, { 'Content-Type': 'text/plain' }); return response.end('DATABASE_URL=postgres://lab:secret@db/lab\nSTRIPE_KEY=sk_test_lab\n');
		case '/.git/HEAD': response.writeHead(200, { 'Content-Type': 'text/plain' }); return response.end('ref: refs/heads/main\n');
		case '/static/pixel.png': response.writeHead(200, { 'Content-Type': 'image/png' }); return response.end(PIXEL);
		case '/static/jquery-1.12.4.js': response.writeHead(200, { 'Content-Type': 'application/javascript' }); return response.end('window.jQuery = window.$ = { fn: { jquery: "1.12.4" } };');
		case '/static/app.js': response.writeHead(200, { 'Content-Type': 'application/javascript' }); return response.end(`var config = { awsKey: "${FAKE_AWS_KEY}" };\n// window.lab is never defined, so this throws\n`);
		case '/robots.txt': response.writeHead(200, { 'Content-Type': 'text/plain' }); return response.end('User-agent: *\n');
		default:
			void link;
			return html(rewrite(layout('Not found', '<main><h1>404</h1><p>No such page.</p></main>')), 404);
	}
}

/** Starts the lab on an ephemeral loopback port. Returns { url, close }. */
export async function startQaLab() {
	const server = http.createServer((request, response) => labHandler(request, response));
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	return { url: `http://127.0.0.1:${port}/`, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }) };
}
