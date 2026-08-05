import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const COOKIE_NAME = 'qase_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 256;
const SCRYPT_OPTIONS = Object.freeze({ N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const SCRYPT_KEY_LENGTH = 64;

function numberInRange(value, fallback, minimum, maximum) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function normaliseEmail(value) {
	return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function validEmail(email) {
	return email.length <= 254 && EMAIL_PATTERN.test(email);
}

function digest(value) {
	return createHash('sha256').update(value).digest('base64url');
}

function sameValue(left, right) {
	if (typeof left !== 'string' || typeof right !== 'string') {
		return false;
	}
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function parseCookies(header = '') {
	const cookies = new Map();
	for (const pair of header.split(';')) {
		const separator = pair.indexOf('=');
		if (separator < 1) continue;
		const name = pair.slice(0, separator).trim();
		const value = pair.slice(separator + 1).trim();
		if (name) cookies.set(name, value);
	}
	return cookies;
}

async function makePasswordRecord(password) {
	const salt = randomBytes(16).toString('base64url');
	const derived = await scrypt(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS);
	return {
		algorithm: 'scrypt',
		salt,
		hash: Buffer.from(derived).toString('base64url'),
		keyLength: SCRYPT_KEY_LENGTH,
		cost: SCRYPT_OPTIONS.N,
		blockSize: SCRYPT_OPTIONS.r,
		parallelization: SCRYPT_OPTIONS.p
	};
}

async function verifyPassword(password, record) {
	if (!record || record.algorithm !== 'scrypt' || typeof record.salt !== 'string' || typeof record.hash !== 'string') {
		return false;
	}
	const options = {
		N: numberInRange(record.cost, SCRYPT_OPTIONS.N, 16_384, 262_144),
		r: numberInRange(record.blockSize, SCRYPT_OPTIONS.r, 1, 32),
		p: numberInRange(record.parallelization, SCRYPT_OPTIONS.p, 1, 8),
		maxmem: 128 * 1024 * 1024
	};
	const length = numberInRange(record.keyLength, SCRYPT_KEY_LENGTH, 32, 128);
	const derived = Buffer.from(await scrypt(password, record.salt, length, options));
	const expected = Buffer.from(record.hash, 'base64url');
	return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function emptyState() {
	return { version: 1, user: undefined, sessions: [] };
}

function defaultAuthFile() {
	if (process.platform === 'win32') {
		const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
		return path.join(base, 'Qase', 'auth.json');
	}
	const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
	return path.join(base, 'qase', 'auth.json');
}

function readState(filePath) {
	if (!fs.existsSync(filePath)) {
		return emptyState();
	}
	const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
	if (parsed?.version !== 1 || !Array.isArray(parsed.sessions)) {
		throw new Error(`Invalid Qase authentication state at ${filePath}.`);
	}
	if (parsed.user && (!validEmail(parsed.user.email) || !parsed.user.password)) {
		throw new Error(`Invalid Qase owner account at ${filePath}.`);
	}
	return parsed;
}

function writeState(filePath, state, exclusive = false) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const json = JSON.stringify(state, undefined, '\t');
	const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
	try {
		const descriptor = fs.openSync(temporary, 'wx', 0o600);
		try {
			fs.writeFileSync(descriptor, json, 'utf8');
			fs.fsyncSync(descriptor);
		} finally {
			fs.closeSync(descriptor);
		}

		if (exclusive) {
			// Linking a fully-written file publishes it atomically and fails with
			// EEXIST if another process won first-run setup.
			fs.linkSync(temporary, filePath);
		} else {
			let renamed = false;
			for (let attempt = 0; attempt < 5 && !renamed; attempt += 1) {
				try {
					fs.renameSync(temporary, filePath);
					renamed = true;
				} catch (error) {
					if (!['EACCES', 'EPERM'].includes(error?.code) || attempt === 4) throw error;
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
				}
			}
		}
		try {
			fs.chmodSync(filePath, 0o600);
		} catch {
			// The default Windows location is the current user's private app-data
			// directory, where access is governed by that user's DACL.
		}
	} finally {
		try {
			fs.rmSync(temporary, { force: true });
		} catch {
			// A successful rename already removed the temporary path.
		}
	}
}

function secureRequest(request, setting) {
	if (setting === true || setting === 'true') return true;
	if (setting === false || setting === 'false') return false;
	return Boolean(request.secure);
}

function cookieHeader(token, { maxAge, secure } = {}) {
	const parts = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
	if (secure) parts.push('Secure');
	if (Number.isFinite(maxAge)) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
	return parts.join('; ');
}

function clearCookieHeader(secure) {
	return `${cookieHeader('', { maxAge: 0, secure })}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function requestOrigin(request) {
	return `${request.protocol}://${request.get('host')}`;
}

function isLoopbackRequest(request) {
	const address = String(request.ip ?? request.socket?.remoteAddress ?? '').toLowerCase();
	return address === '::1' || address === '127.0.0.1' || address.startsWith('127.') || address === '::ffff:127.0.0.1';
}

function isSameOrigin(request) {
	if (request.get('sec-fetch-site') === 'cross-site') return false;
	if (SAFE_METHODS.has(request.method)) return true;
	const origin = request.get('origin');
	if (!origin) return true;
	try {
		return new URL(origin).origin === requestOrigin(request);
	} catch {
		return false;
	}
}

/** Security headers are deliberately dependency-free and apply to static and API responses. */
export function securityHeaders(request, response, next) {
	const demo = request.path === '/demo' || request.path.startsWith('/demo/');
	const scriptPolicy = demo ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'";
	response.set({
		'Content-Security-Policy': `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; ${scriptPolicy}; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
		'Cross-Origin-Opener-Policy': 'same-origin',
		'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
		'X-Frame-Options': 'DENY'
	});
	if (request.secure) {
		response.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	}
	next();
}

/**
 * Single-owner authentication for this local Qase instance.
 *
 * The global run store has no per-user ownership model, so allowing multiple
 * accounts would be misleading and unsafe. The first local setup creates one
 * owner; every existing API route is then protected by an opaque session cookie.
 */
export function createAuthentication(options = {}) {
	const configuredFile = String(options.filePath ?? process.env.QASE_AUTH_FILE ?? '').trim();
	const filePath = configuredFile || defaultAuthFile();
	const now = options.now ?? (() => Date.now());
	const randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'));
	const cookieSecure = options.cookieSecure ?? process.env.QASE_AUTH_COOKIE_SECURE ?? 'auto';
	const setupToken = options.setupToken ?? process.env.QASE_AUTH_SETUP_TOKEN;
	const sessionMs = numberInRange(
		options.sessionMs ?? Number(process.env.QASE_AUTH_SESSION_HOURS) * 60 * 60 * 1000,
		12 * 60 * 60 * 1000,
		15 * 60 * 1000,
		7 * 24 * 60 * 60 * 1000
	);
	const rememberMs = numberInRange(
		options.rememberMs ?? Number(process.env.QASE_AUTH_REMEMBER_DAYS) * 24 * 60 * 60 * 1000,
		30 * 24 * 60 * 60 * 1000,
		24 * 60 * 60 * 1000,
		90 * 24 * 60 * 60 * 1000
	);
	const failureWindowMs = options.failureWindowMs ?? 15 * 60 * 1000;
	const maxFailures = options.maxFailures ?? 5;
	const failures = new Map();
	let state = readState(filePath);
	let setupInFlight = false;

	function save() {
		writeState(filePath, state);
	}

	function cleanSessions() {
		const current = now();
		const sessions = state.sessions.filter(session => Number(session.expiresAt) > current);
		const changed = sessions.length !== state.sessions.length;
		state.sessions = sessions;
		if (changed && state.user) save();
	}

	function currentSession(request) {
		cleanSessions();
		const token = parseCookies(request.get('cookie')).get(COOKIE_NAME);
		if (!token || token.length > 256) return undefined;
		const tokenHash = digest(token);
		const session = state.sessions.find(candidate => sameValue(candidate.tokenHash, tokenHash));
		return session ? { token, session } : undefined;
	}

	function csrfToken(token) {
		return digest(`qase-csrf:${token}`);
	}

	function csrfValid(request, authenticated) {
		return sameValue(request.get('x-qase-csrf-token'), csrfToken(authenticated.token));
	}

	function isSessionActive(sessionId) {
		cleanSessions();
		return typeof sessionId === 'string'
			&& state.sessions.some(session => sameValue(session.tokenHash, sessionId));
	}

	function publicSession(request) {
		const authenticated = currentSession(request);
		return authenticated
			? {
				authenticated: true,
				configured: true,
				user: { email: state.user.email },
				csrfToken: csrfToken(authenticated.token)
			}
			: {
				authenticated: false,
				configured: Boolean(state.user),
				user: undefined,
				...(!state.user && !isLoopbackRequest(request) ? { setupTokenRequired: true } : {})
			};
	}

	function issueSession(request, response, remember) {
		cleanSessions();
		const token = randomToken();
		const ttl = remember ? rememberMs : sessionMs;
		const session = {
			tokenHash: digest(token),
			createdAt: now(),
			expiresAt: now() + ttl,
			remember: Boolean(remember)
		};
		state.sessions.push(session);
		state.sessions = state.sessions.slice(-20);
		save();
		response.set('Set-Cookie', cookieHeader(token, {
			maxAge: remember ? Math.floor(ttl / 1000) : undefined,
			secure: secureRequest(request, cookieSecure)
		}));
		return {
			authenticated: true,
			configured: true,
			user: { email: state.user.email },
			csrfToken: csrfToken(token)
		};
	}

	function rateKeys(request, email) {
		const address = request.ip ?? request.socket?.remoteAddress ?? 'unknown';
		return [`ip:${address}`, `account:${email}`];
	}

	function remainingDelay(keys) {
		let delay = 0;
		for (const key of keys) {
			const entry = failures.get(key);
			if (!entry || entry.resetAt <= now()) {
				failures.delete(key);
				continue;
			}
			if (entry.count >= maxFailures) delay = Math.max(delay, entry.resetAt - now());
		}
		return delay;
	}

	function recordFailure(keys) {
		for (const key of keys) {
			const entry = failures.get(key);
			failures.delete(key);
			failures.set(key, !entry || entry.resetAt <= now()
				? { count: 1, resetAt: now() + failureWindowMs }
				: { count: entry.count + 1, resetAt: entry.resetAt });
		}

		// Keep this process-local limiter bounded during long-running desktop use.
		if (failures.size > 500) {
			for (const [candidate] of failures) {
				failures.delete(candidate);
				if (failures.size <= 500) break;
			}
		}
	}

	function rejectRateLimit(response, delay) {
		response.set('Retry-After', String(Math.max(1, Math.ceil(delay / 1000))));
		response.status(429).json({ error: 'Too many sign-in attempts. Try again later.' });
	}

	function authError(response, error) {
		console.error('[Qase auth]', error instanceof Error ? error.message : String(error));
		if (!response.headersSent) {
			response.status(500).json({ error: 'Authentication is temporarily unavailable.' });
		}
	}

	function requireJson(request, response) {
		if (!request.is('application/json')) {
			response.status(415).json({ error: 'Expected a JSON request.' });
			return false;
		}
		return true;
	}

	function mount(app) {
		app.use('/api', (request, response, next) => {
			response.set('Cache-Control', 'no-store');
			if (!isSameOrigin(request)) {
				response.status(403).json({ error: 'Cross-origin request rejected.' });
				return;
			}
			next();
		});

		app.get('/api/auth/session', (request, response) => {
			response.json(publicSession(request));
		});

		app.post('/api/auth/setup', async (request, response) => {
			try {
				if (!requireJson(request, response)) return;
				if (state.user || setupInFlight || fs.existsSync(filePath)) {
					response.status(409).json({ error: 'The owner account has already been created.' });
					return;
				}
				if (!isLoopbackRequest(request)
					&& (!setupToken || !sameValue(request.get('x-qase-setup-token'), setupToken))) {
					response.status(403).json({
						error: setupToken
							? 'The setup token is incorrect.'
							: 'Remote setup is disabled until QASE_AUTH_SETUP_TOKEN is configured.'
					});
					return;
				}
				const email = normaliseEmail(request.body?.email);
				const password = typeof request.body?.password === 'string' ? request.body.password : '';
				if (!validEmail(email)) {
					response.status(400).json({ error: 'Enter a valid email address.' });
					return;
				}
				if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
					response.status(400).json({ error: `Use a password between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters.` });
					return;
				}

				setupInFlight = true;
				const passwordRecord = await makePasswordRecord(password);
				const token = randomToken();
				const remember = Boolean(request.body?.remember);
				const ttl = remember ? rememberMs : sessionMs;
				const created = now();
				const nextState = {
					version: 1,
					user: { email, password: passwordRecord, createdAt: created },
					sessions: [{ tokenHash: digest(token), createdAt: created, expiresAt: created + ttl, remember }]
				};
				try {
					writeState(filePath, nextState, true);
				} catch (error) {
					if (error?.code === 'EEXIST') {
						state = readState(filePath);
						response.status(409).json({ error: 'The owner account has already been created.' });
						return;
					}
					throw error;
				}
				state = nextState;
				response.set('Set-Cookie', cookieHeader(token, {
					maxAge: remember ? Math.floor(ttl / 1000) : undefined,
					secure: secureRequest(request, cookieSecure)
				}));
				response.status(201).json({
					authenticated: true,
					configured: true,
					user: { email },
					csrfToken: csrfToken(token)
				});
			} catch (error) {
				authError(response, error);
			} finally {
				setupInFlight = false;
			}
		});

		app.post('/api/auth/login', async (request, response) => {
			try {
				if (!requireJson(request, response)) return;
				if (!state.user) {
					response.status(409).json({ error: 'Create the owner account before signing in.' });
					return;
				}
				const email = normaliseEmail(request.body?.email);
				const password = typeof request.body?.password === 'string' ? request.body.password : '';
				if (!validEmail(email) || password.length === 0 || password.length > PASSWORD_MAX_LENGTH) {
					response.status(401).json({ error: 'Email or password is incorrect.' });
					return;
				}
				const keys = rateKeys(request, email);
				const delay = remainingDelay(keys);
				if (delay > 0) {
					rejectRateLimit(response, delay);
					return;
				}
				const passwordMatches = await verifyPassword(password, state.user.password);
				const emailMatches = sameValue(email, state.user.email);
				if (!passwordMatches || !emailMatches) {
					recordFailure(keys);
					response.status(401).json({ error: 'Email or password is incorrect.' });
					return;
				}
				for (const key of keys) failures.delete(key);
				response.json(issueSession(request, response, Boolean(request.body?.remember)));
			} catch (error) {
				authError(response, error);
			}
		});

		app.post('/api/auth/logout', (request, response) => {
			const authenticated = currentSession(request);
			if (authenticated && !csrfValid(request, authenticated)) {
				response.status(403).json({ error: 'Invalid security token.' });
				return;
			}
			if (authenticated) {
				state.sessions = state.sessions.filter(session => session !== authenticated.session);
				save();
			}
			response.set('Set-Cookie', clearCookieHeader(secureRequest(request, cookieSecure)));
			response.status(204).end();
		});

		// Everything registered after this point under /api is owner-only.
		app.use('/api', (request, response, next) => {
			const authenticated = currentSession(request);
			if (!authenticated) {
				response.status(401).json({ error: 'Authentication required.' });
				return;
			}
			if (!SAFE_METHODS.has(request.method) && !csrfValid(request, authenticated)) {
				response.status(403).json({ error: 'Invalid security token.' });
				return;
			}
			request.auth = {
				email: state.user.email,
				sessionId: authenticated.session.tokenHash,
				expiresAt: authenticated.session.expiresAt
			};
			next();
		});
	}

	return { mount, isSessionActive };
}
