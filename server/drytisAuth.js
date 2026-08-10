import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { createDrytisTokenVerifier, DrytisTokenError } from './drytisToken.js';

const COOKIE_NAME = 'qase_session';
const STATE_COOKIE_NAME = 'qase_drytis_state';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function csrf(value) { return createHash('sha256').update(`qase-csrf:${value}`).digest('base64url'); }
function same(left, right) {
	if (typeof left !== 'string' || typeof right !== 'string') return false;
	const a = Buffer.from(left); const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}
function cookies(header = '') {
	const result = new Map();
	for (const part of header.split(';')) {
		const at = part.indexOf('=');
		if (at > 0) result.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
	}
	return result;
}
function secure(request, setting) {
	if (setting === true || setting === 'true') return true;
	if (setting === false || setting === 'false') return false;
	return Boolean(request.secure);
}
function cookieHeader(value, request, setting, maxAge) {
	const parts = [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
	if (secure(request, setting)) parts.push('Secure');
	if (maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
	return parts.join('; ');
}
function stateCookieHeader(value, maxAge = 300) {
	return `${STATE_COOKIE_NAME}=${value}; Path=/auth/drytis; HttpOnly; SameSite=None; Secure; Max-Age=${maxAge}`;
}
function parseCookie(value) {
	if (typeof value !== 'string' || value.length > 512) return undefined;
	const [organizationId, projectId, token, extra] = value.split('.');
	if (extra !== undefined || !UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(projectId)
		|| !/^[A-Za-z0-9_-]{40,128}$/.test(token)) return undefined;
	return { organizationId: organizationId.toLowerCase(), projectId: projectId.toLowerCase(), token, tokenHash: digest(token) };
}
function sameOrigin(request) {
	if (request.get('sec-fetch-site') === 'cross-site') return false;
	if (SAFE_METHODS.has(request.method)) return true;
	const origin = request.get('origin');
	if (!origin) return true;
	try { return new URL(origin).origin === `${request.protocol}://${request.get('host')}`; } catch { return false; }
}

export function createDrytisAuthentication(options = {}) {
	const repository = options.repository;
	const tenant = options.tenantContext;
	if (!repository || !tenant) throw new TypeError('Drytis authentication requires identity persistence and tenant context.');
	const environment = options.environment ?? process.env;
	const verifier = options.verifier ?? createDrytisTokenVerifier({
		issuer: environment.QASE_DRYTIS_ISSUER,
		audience: environment.QASE_DRYTIS_AUDIENCE,
		jwksUrl: environment.QASE_DRYTIS_JWKS_URL
	});
	const loginUrl = String(options.loginUrl ?? environment.QASE_DRYTIS_LOGIN_URL ?? '').trim();
	if (!loginUrl || new URL(loginUrl).protocol !== 'https:') throw new TypeError('QASE_DRYTIS_LOGIN_URL must be an HTTPS URL.');
	const publicUrl = new URL(String(options.publicUrl ?? environment.QASE_PUBLIC_URL ?? '').trim());
	if (publicUrl.protocol !== 'https:' && !options.allowInsecurePublicUrl) throw new TypeError('QASE_PUBLIC_URL must use HTTPS.');
	publicUrl.pathname = publicUrl.pathname.replace(/\/$/, '');
	publicUrl.search = '';
	publicUrl.hash = '';
	// Drytis launch mode requires an HTTPS public origin, so its session cookie
	// is always Secure and cannot be weakened by the local-auth compatibility setting.
	const cookieSecure = true;
	const sessionMs = Math.min(7 * 24 * 60 * 60 * 1000, Math.max(15 * 60 * 1000,
		Number(options.sessionMs ?? environment.QASE_AUTH_SESSION_HOURS * 3600000) || 12 * 60 * 60 * 1000));
	const now = options.now ?? (() => Date.now());
	const randomToken = options.randomToken ?? (() => randomBytes(32).toString('base64url'));

	function assertCell(claims) {
		for (const key of ['organizationId', 'organizationSlug', 'projectId', 'projectSlug']) {
			if (claims[key] !== tenant[key]) throw new DrytisTokenError('Drytis launch token targets a different Qase cell.');
		}
	}
	async function resolveRequest(request) {
		const raw = cookies(request.get('cookie')).get(COOKIE_NAME);
		const parsed = parseCookie(raw);
		if (!parsed || parsed.organizationId !== tenant.organizationId || parsed.projectId !== tenant.projectId) return undefined;
		const session = await repository.resolve(parsed);
		return session ? { raw, parsed, session } : undefined;
	}
	async function publicSession(request) {
		const authenticated = await resolveRequest(request);
		return authenticated ? {
			authenticated: true, configured: true, provider: 'drytis',
			user: { email: authenticated.session.email, name: authenticated.session.displayName },
			organizationId: authenticated.session.organizationId,
			projectId: authenticated.session.projectId,
			role: authenticated.session.role,
			csrfToken: csrf(authenticated.raw)
		} : { authenticated: false, configured: true, provider: 'drytis', loginUrl: '/auth/drytis/start' };
	}

	function mount(app) {
		app.get('/auth/drytis/start', (request, response) => {
			const state = randomToken();
			const destination = new URL(loginUrl);
			destination.searchParams.set('state', state);
			destination.searchParams.set('return_to', new URL('/auth/drytis/exchange', publicUrl).toString());
			response.set('Set-Cookie', stateCookieHeader(state));
			response.set('Cache-Control', 'no-store');
			response.redirect(302, destination.toString());
		});
		app.post('/auth/drytis/exchange', express.urlencoded({ extended: false, limit: '32kb' }), async (request, response) => {
			try {
				const expectedState = cookies(request.get('cookie')).get(STATE_COOKIE_NAME);
				if (!same(expectedState, request.body?.state)) throw new DrytisTokenError('Drytis sign-in state is invalid.');
				const claims = await verifier.verify(request.body?.launch_token);
				assertCell(claims);
				const token = randomToken();
				const tokenHash = digest(token);
				const id = randomUUID();
				const expiresAt = now() + sessionMs;
				await repository.exchange(claims, { id, tokenHash, expiresAt });
				const value = `${tenant.organizationId}.${tenant.projectId}.${token}`;
				response.set('Set-Cookie', cookieHeader(value, request, cookieSecure, Math.floor(sessionMs / 1000)));
				response.append('Set-Cookie', `${stateCookieHeader('', 0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
				response.set('Cache-Control', 'no-store');
				response.redirect(303, '/');
			} catch (error) {
				const status = error?.code === 'QASE_DRYTIS_TOKEN_REPLAY' ? 409 : error instanceof DrytisTokenError ? 401 : 503;
				response.status(status).type('text/plain').send(status === 503
					? 'Drytis sign-in is temporarily unavailable.' : 'Drytis sign-in could not be completed.');
			}
		});

		app.use('/api', (request, response, next) => {
			response.set('Cache-Control', 'no-store');
			if (!sameOrigin(request)) return response.status(403).json({ error: 'Cross-origin request rejected.' });
			next();
		});
		app.get('/api/auth/session', async (request, response) => response.json(await publicSession(request)));
		app.post('/api/auth/logout', async (request, response) => {
			const authenticated = await resolveRequest(request);
			if (authenticated && !same(request.get('x-qase-csrf-token'), csrf(authenticated.raw))) {
				return response.status(403).json({ error: 'Invalid security token.' });
			}
			if (authenticated) await repository.revoke(authenticated.parsed);
			response.set('Set-Cookie', `${cookieHeader('', request, cookieSecure, 0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
			response.status(204).end();
		});
		app.use('/api', async (request, response, next) => {
			try {
				const authenticated = await resolveRequest(request);
				if (!authenticated) return response.status(401).json({ error: 'Authentication required.' });
				if (!SAFE_METHODS.has(request.method) && !same(request.get('x-qase-csrf-token'), csrf(authenticated.raw))) {
					return response.status(403).json({ error: 'Invalid security token.' });
				}
				if (!SAFE_METHODS.has(request.method) && authenticated.session.role === 'viewer') {
					return response.status(403).json({ error: 'This Drytis role has read-only Qase access.' });
				}
				if (request.path === '/config' && !SAFE_METHODS.has(request.method)
					&& !['owner', 'admin'].includes(authenticated.session.role)) {
					return response.status(403).json({ error: 'Qase configuration requires a Drytis administrator.' });
				}
				request.auth = { ...authenticated.session, sessionReference: authenticated.parsed };
				next();
			} catch (error) { next(error); }
		});
	}

	return Object.freeze({
		mount,
		async isSessionActive(reference) {
			if (!reference || typeof reference !== 'object') return false;
			return Boolean(await repository.resolve(reference));
		}
	});
}
