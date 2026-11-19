/**
 * Security detectors. Every probe is non-destructive:
 *   - only GET/HEAD/OPTIONS requests, only to the run's target origin;
 *   - injection probes use an inert marker element (<qase-probe>) or a single
 *     quote and look for unescaped reflection or database error text — no
 *     payload executes script, changes data or attempts authentication;
 *   - exposed-file checks verify content signatures so a soft-404 page is
 *     never reported as a leak.
 * Findings say "indicator" where only a symptom (not exploitation) is observed.
 */
import { candidate } from '../findings.js';

const MARKER = 'qase7x';
const PROBE = `${MARKER}"'><qase-probe data-q="1"></qase-probe>`;
const REDIRECT_TARGET = 'https://example.org/qase-redirect-probe';
const REDIRECT_PARAMS = ['next', 'redirect', 'redirect_uri', 'redirect_url', 'url', 'return', 'returnTo', 'return_to', 'returnUrl', 'continue', 'dest', 'destination', 'goto', 'target', 'callback'];
const REFLECT_PARAMS = ['q', 's', 'search', 'query', 'term', 'keyword', 'name', 'message', 'error', 'id', 'page', 'lang'];
const SQL_ERRORS = /(SQL syntax.*MySQL|Warning: mysqli?_|valid MySQL result|PostgreSQL.*ERROR|pg_query\(\)|ERROR:\s+syntax error at or near|unterminated quoted string|SQLSTATE\[|ORA-\d{5}|Microsoft OLE DB Provider for SQL Server|Unclosed quotation mark after the character string|SQLite3?::|sqlite3\.OperationalError|near ".*": syntax error|System\.Data\.SqlClient)/i;
const STACK_TRACES = /(Traceback \(most recent call last\)|at [\w$.<>]+ \((?:\/|[A-Z]:\\)[^)]+:\d+:\d+\)|Exception in thread "|java\.lang\.\w+Exception|Fatal error: Uncaught|Stack trace:\s*#0|ActionController::RoutingError|Django Version:|Whoops! There was an error|Server Error in '\/' Application)/;

export const SECURITY_FIX = {
	csp_missing: 'Add a Content-Security-Policy header. Start with a report-only policy (default-src \'self\'; script-src \'self\'; object-src \'none\'; base-uri \'self\'; frame-ancestors \'self\') and tighten it until no unsafe-inline/unsafe-eval is needed.',
	csp_weak: 'Remove \'unsafe-inline\' and \'unsafe-eval\' from script-src; use nonces or hashes for the inline scripts you need.',
	hsts_missing: 'Send Strict-Transport-Security: max-age=31536000; includeSubDomains (add preload once every subdomain is HTTPS).',
	clickjacking: 'Prevent framing with Content-Security-Policy: frame-ancestors \'self\' (and X-Frame-Options: SAMEORIGIN for older browsers).',
	nosniff_missing: 'Send X-Content-Type-Options: nosniff on every response.',
	referrer_policy_missing: 'Send Referrer-Policy: strict-origin-when-cross-origin (or stricter).',
	version_disclosure: 'Remove version details from Server and X-Powered-By headers (e.g. app.disable("x-powered-by"), server_tokens off).',
	cookie_flags: 'Set Secure, HttpOnly and SameSite=Lax (or Strict) on session and authentication cookies.',
	cors_reflection: 'Do not reflect arbitrary Origin values. Allow-list exact trusted origins, and never combine a wildcard or reflected origin with Access-Control-Allow-Credentials: true.',
	exposed_file: 'Remove the file from the web root and block dotfiles/backup files at the web server (deny /\\.(git|env|svn|DS_Store)), then rotate any secrets it contained.',
	source_map: 'Do not deploy source maps publicly (or restrict them to authenticated staff) if the source must stay private.',
	directory_listing: 'Disable directory listing (autoindex off / Options -Indexes).',
	reflected_xss: 'HTML-encode user input on output for the right context (HTML body, attribute, JavaScript, URL). Use the framework\'s auto-escaping templates and avoid innerHTML / dangerouslySetInnerHTML with request data. Add a strict CSP as defence in depth.',
	dom_xss: 'Do not write location.hash/search into the DOM with innerHTML/document.write; use textContent or sanitize with a vetted library (DOMPurify).',
	open_redirect: 'Only redirect to relative paths or an allow-list of hosts; reject absolute URLs and protocol-relative (//) values from request parameters.',
	sql_error: 'Use parameterized queries/prepared statements everywhere, never concatenate request input into SQL, and return generic error pages instead of database errors.',
	stack_trace: 'Disable debug mode in production and return generic error pages; log details server-side only.',
	client_secret: 'Remove the secret from client-side code immediately, rotate it, and move the call that needs it to the server.',
	vulnerable_library: 'Upgrade the library to a supported, patched version and add dependency scanning to CI.',
	csrf_token_missing: 'Protect state-changing forms with a per-session CSRF token (or rely on SameSite=Lax/Strict cookies plus Origin checks) and verify it server-side.',
	password_over_http: 'Serve every page that collects credentials over HTTPS and redirect HTTP to HTTPS.',
	https_redirect_missing: 'Redirect every HTTP request to HTTPS with a 301 and enable HSTS.',
	insecure_form_action: 'Post forms only to HTTPS endpoints.',
	security_txt_missing: 'Publish /.well-known/security.txt with a contact address for vulnerability reports (RFC 9116).',
	reverse_tabnabbing: 'Add rel="noopener noreferrer" to links that open external sites in a new tab.'
};

const EXPOSED = [
	{ path: '/.git/HEAD', signature: /^ref: refs\/heads\/|^[0-9a-f]{40}\s*$/m, title: 'Git repository metadata is publicly readable', severity: 'high' },
	{ path: '/.git/config', signature: /\[core\]|\[remote "/, title: 'Git configuration is publicly readable', severity: 'high' },
	{ path: '/.env', signature: /^[A-Z][A-Z0-9_]{2,}\s*=\s*\S/m, title: 'Environment file (.env) is publicly readable', severity: 'critical' },
	{ path: '/.env.local', signature: /^[A-Z][A-Z0-9_]{2,}\s*=\s*\S/m, title: 'Environment file (.env.local) is publicly readable', severity: 'critical' },
	{ path: '/config.json', signature: /"(password|secret|api[_-]?key|token|database)"\s*:/i, title: 'config.json with secrets is publicly readable', severity: 'high' },
	{ path: '/.DS_Store', signature: /Bud1/, title: '.DS_Store file reveals directory contents', severity: 'low', binary: true },
	{ path: '/server-status', signature: /Apache Server Status|Server Version:/i, title: 'Apache server-status page is public', severity: 'medium' },
	{ path: '/phpinfo.php', signature: /phpinfo\(\)|PHP Version/i, title: 'phpinfo() page is public', severity: 'medium' },
	{ path: '/.svn/entries', signature: /^\d+\s*$|svn:/m, title: 'Subversion metadata is publicly readable', severity: 'high' },
	{ path: '/backup.sql', signature: /(CREATE TABLE|INSERT INTO)/i, title: 'Database backup is publicly downloadable', severity: 'critical' },
	{ path: '/wp-config.php.bak', signature: /DB_PASSWORD|DB_NAME/, title: 'WordPress configuration backup is public', severity: 'critical' },
	{ path: '/.npmrc', signature: /_authToken|registry=/, title: '.npmrc with registry credentials is public', severity: 'high' },
	{ path: '/docker-compose.yml', signature: /^services:|^version:\s*['"]?\d/m, title: 'docker-compose.yml is publicly readable', severity: 'medium' }
];

const SECRET_PATTERNS = [
	{ name: 'AWS access key', pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/, severity: 'critical' },
	{ name: 'Private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, severity: 'critical' },
	{ name: 'Stripe secret key', pattern: /\bsk_live_[0-9a-zA-Z]{20,}\b/, severity: 'critical' },
	{ name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, severity: 'critical' },
	{ name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, severity: 'high' },
	{ name: 'OpenAI/Anthropic API key', pattern: /\b(sk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,})\b/, severity: 'critical' },
	{ name: 'SendGrid key', pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/, severity: 'high' },
	{ name: 'Twilio auth token', pattern: /\bSK[0-9a-fA-F]{32}\b/, severity: 'medium' }
];

const LIBRARIES = [
	{ name: 'jQuery', read: 'window.jQuery?.fn?.jquery', below: '3.5.0', advisory: 'XSS in htmlPrefilter (CVE-2020-11022/11023)', severity: 'medium' },
	{ name: 'AngularJS', read: 'window.angular?.version?.full', below: '99.0.0', advisory: 'AngularJS is end-of-life (no security fixes since 2022)', severity: 'medium' },
	{ name: 'Lodash', read: 'window._?.VERSION', below: '4.17.21', advisory: 'Prototype pollution / command injection (CVE-2021-23337, CVE-2020-8203)', severity: 'medium' },
	{ name: 'Bootstrap', read: 'window.bootstrap?.Tooltip?.VERSION || window.jQuery?.fn?.tooltip?.Constructor?.VERSION', below: '3.4.1', advisory: 'XSS in data-* attributes (CVE-2018-14040/14042, CVE-2019-8331)', severity: 'low' },
	{ name: 'Moment.js', read: 'window.moment?.version', below: '2.29.4', advisory: 'ReDoS / path traversal (CVE-2022-31129, CVE-2022-24785)', severity: 'low' },
	{ name: 'Handlebars', read: 'window.Handlebars?.VERSION', below: '4.7.7', advisory: 'Prototype pollution / RCE in templates (CVE-2021-23369)', severity: 'medium' },
	{ name: 'DOMPurify', read: 'window.DOMPurify?.version', below: '2.4.2', advisory: 'Sanitizer bypasses fixed in later releases', severity: 'medium' }
];

function versionBelow(version, minimum) {
	const a = String(version).split(/[.-]/).map(part => parseInt(part, 10) || 0);
	const b = minimum.split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		if ((a[i] ?? 0) < b[i]) return true;
		if ((a[i] ?? 0) > b[i]) return false;
	}
	return false;
}

async function probe(url, { method = 'GET', headers = {}, redirect = 'manual', maxBytes = 65536, timeoutMs = 8000, fetchImpl = fetch } = {}) {
	try {
		const response = await fetchImpl(url, { method, headers: { 'User-Agent': 'QASE-QA/2 (+authorized testing)', ...headers }, redirect, signal: AbortSignal.timeout(timeoutMs) });
		let body = '';
		if (method !== 'HEAD' && response.body) {
			const reader = response.body.getReader();
			const chunks = [];
			let size = 0;
			while (size < maxBytes) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value);
				size += value.byteLength;
			}
			await reader.cancel().catch(() => {});
			body = Buffer.concat(chunks).toString('latin1').slice(0, maxBytes);
		}
		return { status: response.status, headers: Object.fromEntries(response.headers), setCookies: response.headers.getSetCookie?.() ?? [], body, url: response.url };
	} catch (error) {
		return { error: String(error.message).slice(0, 200) };
	}
}

/** Header, cookie, CORS, exposed-file and transport checks for the target origin. */
export async function auditOrigin({ targetUrl, mainResponse, cookies = [], fetchImpl = fetch, deadline = Infinity }) {
	const out = [];
	const origin = new URL(targetUrl).origin;
	const https = targetUrl.startsWith('https:');
	const headers = Object.fromEntries(Object.entries(mainResponse?.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
	const site = { url: targetUrl, category: 'security', data: { siteWide: true } };
	const add = (kind, fields) => out.push(candidate({ detector: `security.${kind}`, fix: SECURITY_FIX[kind], ...site, ...fields, data: { siteWide: true, key: fields.key ?? kind } }));
	const headerEvidence = name => `Response headers for ${targetUrl}: ${name}: ${headers[name] ?? '(absent)'}`;

	// --- Security headers ---
	const csp = headers['content-security-policy'];
	if (!csp) add('csp_missing', { severity: 'medium', confidence: 0.9, title: 'No Content-Security-Policy header',
		actual: 'The page is served without a Content-Security-Policy, so an injected script would run without restriction.', expected: 'A CSP restricts where scripts may load from.', evidence: headerEvidence('content-security-policy') });
	else if (/script-src[^;]*'unsafe-(inline|eval)'|default-src[^;]*'unsafe-(inline|eval)'/.test(csp) && !/'nonce-|'strict-dynamic'/.test(csp)) add('csp_weak', { severity: 'low', confidence: 0.85, title: 'Content-Security-Policy allows unsafe inline or eval scripts',
		actual: `CSP: ${csp.slice(0, 300)}`, expected: 'script-src avoids unsafe-inline and unsafe-eval (use nonces/hashes).' });
	if (https && !headers['strict-transport-security']) add('hsts_missing', { severity: 'medium', confidence: 0.9, title: 'No Strict-Transport-Security (HSTS) header',
		actual: 'Browsers are not told to always use HTTPS, so a first visit over HTTP can be intercepted (SSL stripping).', expected: 'HSTS with a long max-age.', evidence: headerEvidence('strict-transport-security') });
	if (!/frame-ancestors/i.test(csp ?? '') && !headers['x-frame-options']) add('clickjacking', { severity: 'medium', confidence: 0.85, title: 'Page can be framed by any site (clickjacking)',
		actual: 'Neither X-Frame-Options nor CSP frame-ancestors is set, so another site can load this page in an invisible frame and trick users into clicking.', expected: 'Framing is restricted to trusted origins.', evidence: headerEvidence('x-frame-options') });
	if (headers['x-content-type-options']?.toLowerCase() !== 'nosniff') add('nosniff_missing', { severity: 'low', confidence: 0.9, title: 'X-Content-Type-Options: nosniff is missing',
		actual: 'Browsers may MIME-sniff responses, which can turn uploaded files into executable content.', expected: 'X-Content-Type-Options: nosniff on every response.', evidence: headerEvidence('x-content-type-options') });
	if (!headers['referrer-policy']) add('referrer_policy_missing', { severity: 'info', confidence: 0.8, title: 'No Referrer-Policy header',
		actual: 'Full URLs (which may contain tokens or IDs) can leak to third parties in the Referer header.', expected: 'Referrer-Policy: strict-origin-when-cross-origin.' });
	const disclosed = [headers.server, headers['x-powered-by'], headers['x-aspnet-version']].filter(value => value && /\d/.test(value));
	if (disclosed.length) add('version_disclosure', { severity: 'low', confidence: 0.85, title: 'Server software versions are disclosed',
		actual: `Headers reveal: ${disclosed.join('; ')}. Attackers can match these versions to known vulnerabilities.`, expected: 'Response headers do not reveal software versions.' });

	// --- Cookies ---
	const sessionLike = /sess|sid|auth|token|jwt|login|remember|csrf|xsrf|connect\.sid|PHPSESSID|JSESSIONID|ASP\.NET/i;
	const weak = cookies.filter(cookie => sessionLike.test(cookie.name) && (!cookie.httpOnly && !/csrf|xsrf/i.test(cookie.name) || https && !cookie.secure || cookie.sameSite === 'None' && !cookie.secure || !cookie.sameSite));
	if (weak.length) add('cookie_flags', { severity: weak.some(cookie => !cookie.httpOnly && !/csrf|xsrf/i.test(cookie.name)) ? 'medium' : 'low', confidence: 0.8, title: `Session cookie${weak.length > 1 ? 's are' : ' is'} missing security flags`,
		actual: weak.slice(0, 4).map(cookie => `${cookie.name}: ${[!cookie.httpOnly && 'no HttpOnly', https && !cookie.secure && 'no Secure', (!cookie.sameSite || cookie.sameSite === 'None') && `SameSite=${cookie.sameSite || 'unset'}`].filter(Boolean).join(', ')}`).join('; '),
		expected: 'Session cookies are HttpOnly, Secure and SameSite=Lax/Strict.', key: `cookies:${weak.map(cookie => cookie.name).join(',')}` });

	// --- CORS ---
	if (Date.now() < deadline) {
		const evil = 'https://qase-cors-probe.example';
		const response = await probe(targetUrl, { headers: { Origin: evil }, fetchImpl, maxBytes: 1024 });
		const allow = response.headers?.['access-control-allow-origin'];
		const credentials = response.headers?.['access-control-allow-credentials'] === 'true';
		if (allow === evil || allow === 'null') add('cors_reflection', { severity: credentials ? 'high' : 'medium', confidence: 0.9, title: `CORS trusts any origin${credentials ? ' with credentials' : ''}`,
			actual: `A request with Origin: ${evil} received Access-Control-Allow-Origin: ${allow}${credentials ? ' and Access-Control-Allow-Credentials: true, so any website can read authenticated responses' : ''}.`,
			expected: 'Only trusted origins are allowed.', evidence: `GET ${targetUrl} with Origin: ${evil}` });
		else if (allow === '*' && credentials) add('cors_reflection', { severity: 'medium', confidence: 0.7, title: 'CORS wildcard combined with credentials',
			actual: 'Access-Control-Allow-Origin: * is sent together with Access-Control-Allow-Credentials: true.', expected: 'Credentials are only allowed for specific trusted origins.' });
	}

	// --- HTTP → HTTPS ---
	if (https && Date.now() < deadline) {
		const plain = await probe(targetUrl.replace(/^https:/, 'http:'), { fetchImpl, maxBytes: 512, timeoutMs: 5000 });
		if (!plain.error && plain.status >= 200 && plain.status < 300) add('https_redirect_missing', { severity: 'medium', confidence: 0.85, title: 'The site is also served over plain HTTP',
			actual: `http://${new URL(targetUrl).host}/ returned HTTP ${plain.status} instead of redirecting to HTTPS.`, expected: 'HTTP requests are redirected to HTTPS.' });
	} else if (!https) {
		add('https_redirect_missing', { severity: 'high', confidence: 0.9, title: 'The site is not served over HTTPS',
			actual: `${targetUrl} uses plain HTTP; everything users send can be read or changed on the network.`, expected: 'The site uses HTTPS.' });
	}

	// --- Exposed files ---
	const soft404 = await probe(`${origin}/qase-${Date.now().toString(36)}-does-not-exist.txt`, { fetchImpl, maxBytes: 4096 });
	for (const entry of EXPOSED) {
		if (Date.now() >= deadline) break;
		const response = await probe(`${origin}${entry.path}`, { fetchImpl, maxBytes: 16384 });
		if (response.error || response.status !== 200) continue;
		if (soft404.status === 200 && soft404.body && response.body.slice(0, 200) === soft404.body.slice(0, 200)) continue;
		const type = response.headers['content-type'] ?? '';
		if (/text\/html/.test(type) && !/server-status|phpinfo/.test(entry.path)) continue;
		if (!entry.signature.test(response.body)) continue;
		add('exposed_file', { severity: entry.severity, confidence: 0.95, title: entry.title, url: `${origin}${entry.path}`,
			actual: `GET ${origin}${entry.path} returned HTTP 200 with matching content (${response.body.length} bytes${entry.binary ? '' : `, starting "${response.body.slice(0, 40).replace(/[A-Za-z0-9+/=_-]{12,}/g, '[redacted]').replace(/\s+/g, ' ')}…"`}).`,
			expected: 'Repository, configuration and backup files are never served.', key: `exposed:${entry.path}` });
	}
	const securityTxt = await probe(`${origin}/.well-known/security.txt`, { fetchImpl, maxBytes: 2048 });
	if (!securityTxt.error && (securityTxt.status !== 200 || !/contact:/i.test(securityTxt.body))) add('security_txt_missing', { severity: 'info', confidence: 0.9, title: 'No security.txt contact file',
		actual: `${origin}/.well-known/security.txt is missing, so researchers have no documented way to report vulnerabilities.`, expected: 'A security.txt with a Contact field (RFC 9116).' });
	return out;
}

/** Scripts, libraries, forms and links on one loaded page. */
export async function auditPageSecurity(page, { url, viewport, fetchImpl = fetch, scannedScripts = new Set() }) {
	const out = [];
	const add = (kind, fields) => out.push(candidate({ detector: `security.${kind}`, category: 'security', fix: SECURITY_FIX[kind], url, viewport, ...fields }));
	const facts = await page.evaluate(libraries => {
		const read = expression => { try { return Function(`return (${expression})`)(); } catch { return undefined; } };
		return {
			libraries: libraries.map(library => ({ name: library.name, version: read(library.read) })).filter(item => typeof item.version === 'string'),
			scripts: [...document.scripts].map(script => script.src).filter(Boolean).slice(0, 40),
			inline: [...document.scripts].filter(script => !script.src).map(script => script.textContent).join('\n').slice(0, 400000),
			forms: [...document.forms].map(form => ({ method: (form.getAttribute('method') || 'get').toLowerCase(), action: form.action,
				hasPassword: Boolean(form.querySelector('input[type=password]')),
				hasToken: [...form.querySelectorAll('input[type=hidden]')].some(input => /csrf|xsrf|token|authenticity|nonce|_wpnonce|__RequestVerificationToken/i.test(input.name)) })),
			https: location.protocol === 'https:',
			tabnabbing: [...document.querySelectorAll('a[target=_blank]')].filter(anchor => anchor.href.startsWith('http') && new URL(anchor.href).origin !== location.origin && !/noopener|noreferrer/i.test(anchor.rel)).map(anchor => anchor.href).slice(0, 5),
			html: document.documentElement.outerHTML.slice(0, 300000)
		};
	}, LIBRARIES.map(({ name, read }) => ({ name, read }))).catch(() => null);
	if (!facts) return out;

	for (const library of facts.libraries) {
		const rule = LIBRARIES.find(item => item.name === library.name);
		if (rule && versionBelow(library.version, rule.below)) add('vulnerable_library', { severity: rule.severity, confidence: 0.85, title: `Outdated ${library.name} ${library.version} with known vulnerabilities`,
			actual: `The page loads ${library.name} ${library.version}. ${rule.advisory}.`, expected: `${library.name} ${rule.below === '99.0.0' ? 'is replaced with a supported framework' : `${rule.below} or later`}.`, data: { key: `lib:${library.name}`, siteWide: true } });
	}
	// Client-side secrets in inline and same-origin scripts.
	const origin = new URL(url).origin;
	const sources = [{ name: 'inline scripts', text: facts.inline }];
	for (const src of facts.scripts.filter(src => src.startsWith(origin) && !scannedScripts.has(src)).slice(0, 12)) {
		scannedScripts.add(src);
		const response = await probe(src, { fetchImpl, maxBytes: 3_000_000, redirect: 'follow' });
		if (!response.error && response.status === 200) {
			sources.push({ name: src, text: response.body });
			if (/\/\/# sourceMappingURL=(?!data:)(\S+\.map)/.test(response.body.slice(-500))) {
				const map = new URL(response.body.slice(-500).match(/\/\/# sourceMappingURL=(\S+)/)[1], src).href;
				const mapResponse = await probe(map, { method: 'HEAD', fetchImpl });
				if (mapResponse.status === 200) add('source_map', { severity: 'low', confidence: 0.8, title: 'JavaScript source maps are publicly available',
					actual: `${map} is downloadable, exposing the original application source code.`, expected: 'Source maps are not public in production (unless intentionally open source).', data: { key: 'source_map', siteWide: true } });
			}
		}
	}
	for (const source of sources) {
		for (const secret of SECRET_PATTERNS) {
			const match = source.text?.match(secret.pattern);
			if (match) add('client_secret', { severity: secret.severity, confidence: 0.85, title: `${secret.name} exposed in client-side code`,
				actual: `${source.name} contains what looks like a ${secret.name}: ${match[0].slice(0, 6)}…${match[0].slice(-2)} (redacted). Anyone can read it from the browser.`,
				expected: 'Secrets stay on the server.', data: { key: `secret:${secret.name}:${match[0].slice(0, 10)}`, siteWide: true } });
		}
	}
	// Forms: CSRF tokens, credentials over HTTP.
	for (const form of facts.forms) {
		if (form.method === 'post' && !form.hasToken && form.action.startsWith(origin)) {
			add('csrf_token_missing', { severity: 'low', confidence: 0.5, title: 'POST form has no anti-CSRF token (indicator)',
				actual: `The form posting to ${form.action} has no hidden CSRF token. If its session cookie is not SameSite, another site could submit it on a user's behalf.`,
				expected: 'State-changing forms carry a CSRF token or rely on SameSite cookies with Origin checks.', data: { key: `csrf:${form.action.split('?')[0]}` } });
		}
		if (form.hasPassword && (!facts.https || form.action.startsWith('http:'))) add('password_over_http', { severity: 'high', confidence: 0.9, title: 'Password is sent over an unencrypted connection',
			actual: `The sign-in form ${facts.https ? `posts to ${form.action}` : 'is on an HTTP page'}, so the password travels in clear text.`, expected: 'Credentials are only sent over HTTPS.', data: { key: `pw_http:${form.action}` } });
		else if (facts.https && form.action.startsWith('http:')) add('insecure_form_action', { severity: 'medium', confidence: 0.85, title: 'Form posts to an HTTP address',
			actual: `The form on this HTTPS page submits to ${form.action}.`, expected: 'Forms submit over HTTPS.', data: { key: `form_http:${form.action}` } });
	}
	if (facts.tabnabbing.length) add('reverse_tabnabbing', { severity: 'info', confidence: 0.6, title: 'External links open in a new tab without rel="noopener"',
		actual: `Examples: ${facts.tabnabbing.join(', ')}. Older browsers let the opened page redirect this tab.`, expected: 'External target=_blank links use rel="noopener noreferrer".', data: { key: 'tabnabbing', siteWide: true } });
	if (STACK_TRACES.test(facts.html)) add('stack_trace', { severity: 'medium', confidence: 0.75, title: 'Page shows a server stack trace or debug output',
		actual: `The page contains debug output: "${facts.html.match(STACK_TRACES)[0].slice(0, 120)}".`, expected: 'Errors are shown as generic pages; details stay in server logs.', data: { key: 'stack_trace' } });
	return out;
}

/**
 * Injection probes for one URL: reflected XSS markers, DOM XSS through the
 * hash, error-based SQL indicators and open redirects. Uses its own page.
 */
export async function probeInjection({ browser, profile, url, params = [], fetchImpl = fetch, deadline = Infinity }) {
	const out = [];
	const target = new URL(url);
	const names = [...new Set([...params, ...target.searchParams.keys(), ...REFLECT_PARAMS])].slice(0, 14);
	const { page, log } = await browser.openPage(profile);
	try {
		// Reflected XSS: all parameters at once, then confirm which one reflects.
		const probeUrl = new URL(url);
		for (const name of names) probeUrl.searchParams.set(name, PROBE);
		await browser.goto(page, probeUrl.href, log, { timeoutMs: 20000 }).catch(() => {});
		const reflected = await page.evaluate(() => document.querySelectorAll('qase-probe[data-q="1"]').length).catch(() => 0);
		if (reflected) {
			let culprit;
			for (const name of names) {
				if (Date.now() >= deadline) break;
				const single = new URL(url);
				single.searchParams.set(name, PROBE);
				await browser.goto(page, single.href, log, { timeoutMs: 15000 }).catch(() => {});
				if (await page.evaluate(() => document.querySelectorAll('qase-probe[data-q="1"]').length).catch(() => 0)) { culprit = name; break; }
			}
			out.push(candidate({ detector: 'security.reflected_xss', category: 'security', severity: 'high', confidence: 0.95, url,
				title: `Reflected cross-site scripting (XSS) via the "${culprit ?? names[0]}" parameter`,
				actual: `Putting the harmless marker ${PROBE.replace(/</g, '‹')} in the ${culprit ?? 'query'} parameter created a real <qase-probe> element in the page, so the parameter is inserted into HTML without escaping. A script tag would run the same way.`,
				expected: 'User input is HTML-encoded before it is placed in the page.', steps: [`Open ${url.split('?')[0]}?${culprit ?? names[0]}=<qase-probe></qase-probe>`, 'Inspect the DOM: the element is parsed as HTML'],
				evidence: `Probe URL: ${(() => { const u = new URL(url); u.searchParams.set(culprit ?? names[0], PROBE); return u.href; })()}`, fix: SECURITY_FIX.reflected_xss, data: { key: `xss:${target.pathname}:${culprit}` } }));
		} else {
			const raw = await page.content().catch(() => '');
			const index = raw.indexOf(`${MARKER}"'>`);
			const inScript = index >= 0 && raw.lastIndexOf('<script', index) > raw.lastIndexOf('</script', index);
			if (inScript) out.push(candidate({ detector: 'security.reflected_xss', category: 'security', severity: 'high', confidence: 0.75, url,
				title: 'Request input is inserted unescaped into a script block (XSS indicator)',
				actual: 'The marker including its quote characters appears unescaped inside an inline <script>, which lets input break out of a JavaScript string.',
				expected: 'Input placed in scripts is JSON-encoded/escaped.', fix: SECURITY_FIX.reflected_xss, data: { key: `xss_script:${target.pathname}` } }));
		}
		if (STACK_TRACES.test(await page.content().catch(() => ''))) out.push(candidate({ detector: 'security.stack_trace', category: 'security', severity: 'medium', confidence: 0.7, url,
			title: 'Unexpected input produces a stack trace', actual: 'Sending unusual query parameters made the page display debug/stack-trace output.',
			expected: 'Invalid input returns a generic error.', fix: SECURITY_FIX.stack_trace, data: { key: `trace_probe:${target.pathname}` } }));

		// DOM XSS via the fragment.
		if (Date.now() < deadline) {
			await browser.goto(page, `${url.split('#')[0]}#${encodeURIComponent(PROBE)}`, log, { timeoutMs: 15000 }).catch(() => {});
			await page.waitForTimeout(400);
			const domHit = await page.evaluate(() => document.querySelectorAll('qase-probe[data-q="1"]').length).catch(() => 0);
			if (domHit) out.push(candidate({ detector: 'security.dom_xss', category: 'security', severity: 'high', confidence: 0.9, url,
				title: 'DOM-based XSS through the URL fragment', actual: 'A marker element placed in the URL #fragment was written into the page as HTML by client-side script.',
				expected: 'Client-side code treats location data as text.', fix: SECURITY_FIX.dom_xss, data: { key: `domxss:${target.pathname}` } }));
		}

		// Error-based SQL injection indicator (single quote only).
		if (Date.now() < deadline) {
			const quoteParams = [...target.searchParams.keys()].length ? [...target.searchParams.keys()] : ['id', 'q'];
			for (const name of quoteParams.slice(0, 4)) {
				const sql = new URL(url);
				sql.searchParams.set(name, `${sql.searchParams.get(name) ?? '1'}'`);
				const response = await probe(sql.href, { fetchImpl, maxBytes: 200000, redirect: 'follow' });
				if (!response.error && SQL_ERRORS.test(response.body)) {
					out.push(candidate({ detector: 'security.sql_error', category: 'security', severity: 'high', confidence: 0.85, url,
						title: `SQL injection indicator: a quote in "${name}" causes a database error`,
						actual: `Adding a single quote to the ${name} parameter returned a database error ("${response.body.match(SQL_ERRORS)[0].slice(0, 100)}"), which shows the input reaches a SQL query unsanitized.`,
						expected: 'Input is passed to the database through parameterized queries; errors are generic.', evidence: `GET ${sql.href} → HTTP ${response.status}`,
						steps: [`Open ${sql.href}`], fix: SECURITY_FIX.sql_error, data: { key: `sql:${target.pathname}:${name}` } }));
					break;
				}
			}
		}
	} finally {
		await page.close().catch(() => {});
	}
	return out;
}

/** Open-redirect probes against the target and sign-in-like routes. */
const AUTH_PATHS = ['/login', '/signin', '/sign-in', '/auth/login', '/account/login', '/logout', '/redirect', '/out'];

/** Common sign-in/redirect routes that exist on the target (by a plain GET). */
export async function discoverAuthRoutes(origin, { fetchImpl = fetch } = {}) {
	const found = [];
	for (const path of AUTH_PATHS) {
		const response = await probe(`${origin}${path}`, { fetchImpl, maxBytes: 2048 });
		if (!response.error && (response.status === 200 || response.status >= 300 && response.status < 400)) found.push(`${origin}${path}`);
		if (found.length >= 3) break;
	}
	return found;
}

export async function probeRedirects({ urls, fetchImpl = fetch, deadline = Infinity }) {
	const out = [];
	for (const url of [...new Set(urls)].slice(0, 5)) {
		for (const name of REDIRECT_PARAMS) {
			if (Date.now() >= deadline) return out;
			const test = new URL(url);
			test.searchParams.set(name, REDIRECT_TARGET);
			const response = await probe(test.href, { fetchImpl, maxBytes: 4096 });
			const location = response.headers?.location ?? '';
			const meta = /http-equiv=["']?refresh["']?[^>]*url=https:\/\/example\.org/i.test(response.body ?? '') || /location(?:\.href)?\s*=\s*["']https:\/\/example\.org\/qase-redirect-probe/.test(response.body ?? '');
			if (response.status >= 300 && response.status < 400 && /^(https?:)?\/\/example\.org/i.test(location) || meta) {
				out.push(candidate({ detector: 'security.open_redirect', category: 'security', severity: 'medium', confidence: 0.9, url,
					title: `Open redirect via the "${name}" parameter`,
					actual: `${test.href} redirects to ${location || REDIRECT_TARGET}. Attackers can use this trusted domain to send users to phishing sites.`,
					expected: 'Redirect targets are limited to this site or an allow-list.', steps: [`Open ${test.href}`, 'Observe the redirect to example.org'],
					fix: SECURITY_FIX.open_redirect, data: { key: `redirect:${new URL(url).pathname}:${name}` } }));
				break;
			}
		}
	}
	return out;
}
