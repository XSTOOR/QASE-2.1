import { promisify } from 'node:util';
import { randomBytes, randomUUID, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { accountSettingsCodec } from './accountSettings.js';
import { createAuthThrottle } from './authThrottle.js';

const scrypt = promisify(scryptCallback);
const AUTH_FILE = path.join(process.cwd(), '.qase', 'auth.json');
const PASSWORD_MIN_LENGTH = 12;
const DUMMY_PASSWORD_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PASSWORD_MAX_LENGTH = 200;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MEMORY_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const SENSITIVE_MEMORY = /(password|secret|token|api[._-]?key|credential|private[._-]?key)/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const AUTH_COOKIE = 'qase_session';
export const CSRF_COOKIE = 'qase_csrf';
export const AUTH_SESSION_TTL_MS = SESSION_TTL_MS;

export class AuthError extends Error {
	constructor(message, code = 'auth_error', status = 400) {
		super(message);
		this.name = 'AuthError';
		this.code = code;
		this.status = status;
	}
}

function assertText(value, field, max = 200) {
	if (typeof value !== 'string' || value.trim() === '' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
		throw new AuthError(`${field} is invalid.`, 'invalid_input', 400);
	}
	return value.trim();
}

export function normalizeEmail(value) {
	const email = assertText(value, 'Email', 254).toLowerCase();
	if (!EMAIL.test(email)) throw new AuthError('Enter a valid email address.', 'invalid_email', 400);
	return email;
}

function normalizeDisplayName(value) {
	const name = assertText(value, 'Display name', 120);
	if (name.length < 1) throw new AuthError('Display name is required.', 'invalid_display_name', 400);
	return name;
}

export function validatePassword(value) {
	if (typeof value !== 'string' || value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) {
		throw new AuthError(`Password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters.`, 'weak_password', 400);
	}
	return value;
}

function safeUser(user) {
	return user ? Object.freeze({
		id: user.id,
		userId: user.id,
		email: user.email,
		displayName: user.displayName,
		role: user.role ?? 'owner',
		createdAt: user.createdAt,
		profile: user.profile ? structuredClone(user.profile) : undefined
	}) : undefined;
}

function actor(user, tenantContext) {
	return Object.freeze({
		...safeUser(user),
		actorUserId: user.id,
		organizationId: tenantContext.organizationId,
		projectId: tenantContext.projectId,
		actorEmail: user.email,
		actorName: user.displayName
	});
}

function passwordRecord(password) {
	validatePassword(password);
	const salt = randomBytes(16);
	const N = 16_384;
	const r = 8;
	const p = 1;
	return scrypt(password, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 }).then(key =>
		`scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${Buffer.from(key).toString('base64url')}`
	);
}

async function verifyPassword(password, encoded) {
	if (typeof password !== 'string' || password.length > PASSWORD_MAX_LENGTH) return false;
	if (typeof password !== 'string' || typeof encoded !== 'string') return false;
	const [, n, r, p, saltText, digestText] = encoded.split('$');
	const N = Number(n);
	const R = Number(r);
	const P = Number(p);
	if (!Number.isSafeInteger(N) || !Number.isSafeInteger(R) || !Number.isSafeInteger(P)
		|| N < 16_384 || R < 1 || P < 1 || !saltText || !digestText) return false;
	try {
		const expected = Buffer.from(digestText, 'base64url');
		const actual = Buffer.from(await scrypt(password, Buffer.from(saltText, 'base64url'), expected.length, {
			N, r: R, p: P, maxmem: 64 * 1024 * 1024
		}));
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	} catch {
		return false;
	}
}

function tokenHash(token) {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

function newToken() {
	return randomBytes(32).toString('base64url');
}

function parseCookieHeader(header) {
	const values = {};
	for (const chunk of String(header ?? '').split(';')) {
		const index = chunk.indexOf('=');
		if (index < 1) continue;
		const key = chunk.slice(0, index).trim();
		const value = chunk.slice(index + 1).trim();
		if (!key || value.length > 512) continue;
		try { values[key] = decodeURIComponent(value); } catch { values[key] = value; }
	}
	return values;
}

export function requestAuthToken(request) {
	return parseCookieHeader(request?.headers?.cookie)[AUTH_COOKIE];
}

export function requestCsrfToken(request) {
	return request?.headers?.['x-csrf-token'];
}

export function requestCookieCsrfToken(request) {
	return parseCookieHeader(request?.headers?.cookie)[CSRF_COOKIE];
}

export function setAuthCookies(response, token, csrfToken, { secure = false } = {}) {
	const secureFlag = secure ? '; Secure' : '';
	const maxAge = Math.floor(SESSION_TTL_MS / 1000);
	response.append('Set-Cookie', `${AUTH_COOKIE}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secureFlag}`);
	response.append('Set-Cookie', `${CSRF_COOKIE}=${encodeURIComponent(csrfToken)}; Max-Age=${maxAge}; Path=/; SameSite=Lax${secureFlag}`);
}

export function clearAuthCookies(response, { secure = false } = {}) {
	const secureFlag = secure ? '; Secure' : '';
	response.append('Set-Cookie', `${AUTH_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secureFlag}`);
	response.append('Set-Cookie', `${CSRF_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax${secureFlag}`);
}

function csrfToken() { return randomBytes(24).toString('base64url'); }

function defaultProfile() {
	return { timezone: 'UTC', locale: 'en', preferences: {}, onboardingComplete: false };
}

function cleanProfilePatch(input) {
	const profile = input?.profile;
	if (profile !== undefined && (!profile || typeof profile !== 'object' || Array.isArray(profile))) {
		throw new AuthError('Profile settings must be an object.', 'invalid_profile', 400);
	}
	const next = {};
	if (profile?.timezone !== undefined) { next.timezone = assertText(profile.timezone, 'Timezone', 100); try { new Intl.DateTimeFormat('en', { timeZone: next.timezone }); } catch { throw new AuthError('Enter a valid IANA timezone, such as Asia/Kolkata.', 'invalid_profile', 400); } }
	if (profile?.locale !== undefined) next.locale = assertText(profile.locale, 'Locale', 20);
	if (profile?.onboardingComplete !== undefined) {
		if (typeof profile.onboardingComplete !== 'boolean') throw new AuthError('onboardingComplete must be boolean.', 'invalid_profile', 400);
		next.onboardingComplete = profile.onboardingComplete;
	}
	if (profile?.preferences !== undefined) {
		if (!profile.preferences || typeof profile.preferences !== 'object' || Array.isArray(profile.preferences)) throw new AuthError('Profile preferences must be an object.', 'invalid_profile', 400);
		const encoded = JSON.stringify(profile.preferences);
		if (Buffer.byteLength(encoded, 'utf8') > 20_000 || SENSITIVE_MEMORY.test(encoded)) throw new AuthError('Profile preferences are too large or contain sensitive data.', 'invalid_profile', 400);
		next.preferences = structuredClone(profile.preferences);
	}
	return next;
}

function cleanMemoryInput(input) {
	const key = assertText(input?.key, 'Memory key', 80);
	if (!MEMORY_KEY.test(key) || SENSITIVE_MEMORY.test(key)) throw new AuthError('Memory keys cannot contain credentials or secrets.', 'invalid_memory_key', 400);
	const value = assertText(typeof input?.value === 'string' ? input.value : JSON.stringify(input?.value), 'Memory value', 4000);
	if (SENSITIVE_MEMORY.test(value)) throw new AuthError('Memory cannot contain credentials or secrets.', 'sensitive_memory', 400);
	const scope = input?.scope === 'project' ? 'project' : 'user';
	const kind = ['preference', 'fact', 'instruction'].includes(input?.kind) ? input.kind : 'fact';
	return { key, value, scope, kind };
}

function publicMemory(entry) {
	return { id: entry.id, key: entry.key, value: entry.value, scope: entry.scope, kind: entry.kind, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
}

function userFromRow(row, profile) {
	return {
		id: row.id ?? row.user_id,
		email: row.email,
		displayName: row.display_name,
		role: row.role ?? 'owner',
		createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
		profile: profile ?? defaultProfile()
	};
}

async function withLock(state, work) {
	const prior = state.lock;
	let release;
	state.lock = new Promise(resolve => { release = resolve; });
	await prior;
	const snapshot = structuredClone(state.data);
	try { return await work(); } catch (error) { state.data = snapshot; throw error; } finally { release(); }
}

function createLocalDataStore({ tenantContext, now = () => Date.now(), file = AUTH_FILE } = {}) {
	const settingsCodec = accountSettingsCodec({ file });
	const consumeAuthAttempt = createAuthThrottle({ now });
	const state = { loaded: false, data: { version: 1, users: [], sessions: [], memory: [] }, lock: Promise.resolve() };
	async function persist() {
		await fs.promises.mkdir(path.dirname(file), { recursive: true });
		const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
		await fs.promises.writeFile(temporary, JSON.stringify(state.data), { mode: 0o600 });
		await fs.promises.rename(temporary, file);
	}
	let loading;
	async function load() {
		if (state.loaded) return;
		if (!loading) loading = loadData().catch(error => { loading = undefined; throw error; });
		return loading;
	}
	async function loadData() {
		try {
			const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
			if (parsed?.version === 1 && Array.isArray(parsed.users) && Array.isArray(parsed.sessions)) {
				state.data = parsed;
				for (const user of state.data.users) {
					user.status ??= 'active';
					user.role ??= 'owner';
					user.profile ??= defaultProfile();
				}
			}
		} catch (error) {
			if (error?.code !== 'ENOENT') throw new Error('The local authentication store is unreadable.');
		}
		state.loaded = true;
	}
function findUser(id) { return state.data.users.find(user => user.id === id); }
	async function createAccount({ email, password, displayName }) {
		await load();
		return withLock(state, async () => {
			const normalized = normalizeEmail(email);
			if (state.data.users.some(user => user.email === normalized)) throw new AuthError('An account with that email already exists.', 'email_taken', 409);
			const user = { id: randomUUID(), email: normalized, displayName: normalizeDisplayName(displayName || normalized.split('@')[0]), passwordHash: await passwordRecord(password), status: 'active', role: 'developer', createdAt: now(), updatedAt: now(), profile: defaultProfile() };
			state.data.users.push(user);
			await persist();
			return user;
		});
	}
	async function issueSession(user) {
		return withLock(state, async () => {
			const token = newToken();
			const csrf = csrfToken();
			state.data.sessions = state.data.sessions.filter(session => session.expiresAt > now() && session.userId !== user.id);
			state.data.sessions.push({ id: randomUUID(), userId: user.id, tokenHash: tokenHash(token), createdAt: now(), expiresAt: now() + SESSION_TTL_MS });
			await persist();
			return { token, csrf, user: actor(user, tenantContext) };
		});
	}
	async function authenticate(token) {
		await load();
		if (typeof token !== 'string' || token.length < 20) return undefined;
		const session = state.data.sessions.find(candidate => candidate.tokenHash === tokenHash(token) && candidate.expiresAt > now());
		const user = session && findUser(session.userId);
		return user && user.status !== 'disabled' && user.status !== 'suspended' ? actor(user, tenantContext) : undefined;
	}
	return {
		async load() { await load(); },
		async register(input) { const user = await createAccount(input); return issueSession(user); },
		async login(input) {
			await load();
			const user = state.data.users.find(candidate => candidate.email === normalizeEmail(input?.email));
			const valid = await verifyPassword(input?.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
			if (!user || user.status !== 'active' || !valid) throw new AuthError('Email or password is incorrect.', 'invalid_credentials', 401);
			return issueSession(user);
		},
		authenticate,
		consumeAuthAttempt,
		async getSettings(userId) { await load(); return settingsCodec.open(userId, findUser(userId)?.settings); },
		async saveSettings(userId, settings) { await load(); return withLock(state, async () => { const user = findUser(userId); if (!user) throw new AuthError('Account not found.', 'not_found', 404); user.settings = await settingsCodec.seal(userId, settings); await persist(); }); },
		async changePassword(userId, input) { await load(); return withLock(state, async () => { const user = findUser(userId); if (!user || !(await verifyPassword(input?.currentPassword, user.passwordHash))) throw new AuthError('Current password is incorrect.', 'invalid_credentials', 401); const passwordHash = await passwordRecord(input?.password); user.passwordHash = passwordHash; state.data.sessions = state.data.sessions.filter(session => session.userId !== userId); await persist(); }); },
		async logout(token) { await load(); return withLock(state, async () => { state.data.sessions = state.data.sessions.filter(session => session.tokenHash !== tokenHash(String(token ?? ''))); await persist(); }); },
		async profile(userId) { await load(); const user = findUser(userId); return user ? { ...safeUser(user), profile: structuredClone(user.profile ?? defaultProfile()) } : undefined; },
		async updateProfile(userId, input) { await load(); return withLock(state, async () => { const user = findUser(userId); if (!user) throw new AuthError('Profile not found.', 'not_found', 404); const name = input?.displayName === undefined ? user.displayName : normalizeDisplayName(input.displayName); const patch = cleanProfilePatch(input); user.displayName = name; user.profile = { ...defaultProfile(), ...user.profile, ...patch }; user.updatedAt = now(); await persist(); return { ...safeUser(user), profile: structuredClone(user.profile) }; }); },
		async listMemory(userId) { await load(); return (state.data.memory ?? []).filter(entry => entry.userId === userId).sort((a, b) => b.updatedAt - a.updatedAt).map(publicMemory); },
		async putMemory(userId, input) { await load(); return withLock(state, async () => { const clean = cleanMemoryInput(input); const timestamp = now(); let entry = (state.data.memory ?? []).find(candidate => candidate.userId === userId && candidate.scope === clean.scope && candidate.key === clean.key); if (!entry && (state.data.memory ?? []).filter(candidate => candidate.userId === userId).length >= 100) throw new AuthError('Memory is limited to 100 entries per account.', 'memory_limit', 400); if (entry) Object.assign(entry, clean, { updatedAt: timestamp }); else { entry = { id: randomUUID(), userId, ...clean, createdAt: timestamp, updatedAt: timestamp }; (state.data.memory ??= []).push(entry); } await persist(); return publicMemory(entry); }); },
		async deleteMemory(userId, id) { await load(); return withLock(state, async () => { const index = (state.data.memory ?? []).findIndex(entry => entry.userId === userId && entry.id === id); if (index < 0) return false; state.data.memory.splice(index, 1); await persist(); return true; }); },
		async check() { await load(); return { ready: true, backend: 'local', users: state.data.users.length }; },
		async close() { if (state.loaded) await persist(); }
	};
}

function pgDate(value) { return value instanceof Date ? value : new Date(value); }

export function createPostgresAuthService({ pool, tenantContext, now = () => Date.now() } = {}) {
	const settingsCodec = accountSettingsCodec();
	if (!pool || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required for authentication.');
	const tenant = tenantContext;
	async function transaction(work) {
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await client.query("SELECT set_config('qase.organization_id', $1, true), set_config('qase.project_id', $2, true)", [tenant.organizationId, tenant.projectId]);
			const result = await work(client);
			await client.query('COMMIT');
			return result;
		} catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
	}
	async function selectUser(client, userId) {
		const result = await client.query(`SELECT users.id, users.email, users.display_name, users.created_at, membership.role
			FROM users JOIN organization_memberships membership ON membership.user_id = users.id
			WHERE users.id = $1 AND membership.organization_id = $2 AND membership.status = 'active' AND users.status = 'active'`, [userId, tenant.organizationId]);
		if (!result.rows[0]) return undefined;
		const profile = await client.query('SELECT timezone, locale, preferences, onboarding_complete FROM qase_user_profiles WHERE user_id = $1', [userId]);
		const row = result.rows[0];
		return userFromRow(row, profile.rows[0] ? { timezone: profile.rows[0].timezone, locale: profile.rows[0].locale, preferences: profile.rows[0].preferences ?? {}, onboardingComplete: profile.rows[0].onboarding_complete } : undefined);
	}
	async function issueSession(client, user) {
		const token = newToken(); const csrf = csrfToken(); const expires = new Date(now() + SESSION_TTL_MS);
		await client.query('UPDATE qase_auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND revoked_at IS NULL', [user.id]);
		await client.query(`INSERT INTO qase_auth_sessions (id, organization_id, project_id, user_id, token_hash, created_at, expires_at, last_seen_at)
			VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP,$6,CURRENT_TIMESTAMP)`, [randomUUID(), tenant.organizationId, tenant.projectId, user.id, tokenHash(token), expires]);
		return { token, csrf, user: actor(user, tenant) };
	}
	return {
		async load() {},
		async consumeAuthAttempt(key, limit) { return transaction(async client => {
			await client.query('DELETE FROM qase_auth_attempts WHERE expires_at < CURRENT_TIMESTAMP');
			const result = await client.query(`INSERT INTO qase_auth_attempts (organization_id, project_id, key, attempts, expires_at)
				VALUES ($1,$2,$3,1,CURRENT_TIMESTAMP + INTERVAL '15 minutes')
				ON CONFLICT (organization_id,project_id,key) DO UPDATE SET attempts = qase_auth_attempts.attempts + 1
				RETURNING attempts`, [tenant.organizationId, tenant.projectId, key]);
			return result.rows[0].attempts <= limit;
		}); },
		async getSettings(userId) { return transaction(async client => { const result = await client.query('SELECT settings FROM qase_user_profiles WHERE user_id = $1', [userId]); return settingsCodec.open(userId, result.rows[0]?.settings); }); },
		async saveSettings(userId, settings) { const sealed = await settingsCodec.seal(userId, settings); return transaction(async client => { const result = await client.query('UPDATE qase_user_profiles SET settings = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1', [userId, sealed]); if (!result.rowCount) throw new AuthError('Account not found.', 'not_found', 404); }); },
		async changePassword(userId, input) { return transaction(async client => { if (!await selectUser(client, userId)) throw new AuthError('Account not found.', 'not_found', 404); const result = await client.query('SELECT password_hash FROM users WHERE id = $1 FOR UPDATE', [userId]); if (!await verifyPassword(input?.currentPassword, result.rows[0]?.password_hash)) throw new AuthError('Current password is incorrect.', 'invalid_credentials', 401); const hash = await passwordRecord(input?.password); await client.query('UPDATE users SET password_hash = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [userId, hash]); await client.query('UPDATE qase_auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND revoked_at IS NULL', [userId]); }); },
		async register(input) {
			const email = normalizeEmail(input?.email); const displayName = normalizeDisplayName(input?.displayName || email.split('@')[0]); const passwordHash = await passwordRecord(input?.password);
			return transaction(async client => {
				const existing = await client.query('SELECT id FROM users WHERE normalized_email = $1', [email]);
				if (existing.rows.length) throw new AuthError('An account with that email already exists.', 'email_taken', 409);
				const id = randomUUID();
				await client.query(`INSERT INTO users (id,email,normalized_email,display_name,password_hash,status) VALUES ($1,$2,$2,$3,$4,'active')`, [id, email, displayName, passwordHash]);
				await client.query(`INSERT INTO organization_memberships (organization_id,user_id,role,status,created_by_user_id) VALUES ($1,$2,'developer','active',$2)`, [tenant.organizationId, id]);
				await client.query(`INSERT INTO qase_user_profiles (user_id,organization_id,project_id) VALUES ($1,$2,$3)`, [id, tenant.organizationId, tenant.projectId]);
				const user = await selectUser(client, id); return issueSession(client, user);
			});
		},
		async login(input) {
			const email = normalizeEmail(input?.email);
			return transaction(async client => {
				const result = await client.query(`SELECT users.id, users.email, users.display_name, users.password_hash, users.created_at, membership.role
					FROM users JOIN organization_memberships membership ON membership.user_id = users.id
					WHERE users.normalized_email = $1 AND membership.organization_id = $2 AND membership.status = 'active' AND users.status = 'active'`, [email, tenant.organizationId]);
				const row = result.rows[0];
				const valid = await verifyPassword(input?.password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
				if (!row || !valid) throw new AuthError('Email or password is incorrect.', 'invalid_credentials', 401);
				return issueSession(client, await selectUser(client, row.id));
			});
		},
		async authenticate(token) {
			if (typeof token !== 'string' || token.length < 20) return undefined;
			return transaction(async client => {
				const result = await client.query(`SELECT session.user_id, users.id, users.email, users.display_name, users.created_at, membership.role
					FROM qase_auth_sessions session JOIN users ON users.id = session.user_id
					JOIN organization_memberships membership ON membership.user_id = users.id AND membership.organization_id = session.organization_id
					WHERE session.organization_id = $1 AND session.project_id = $2 AND session.token_hash = $3
					AND session.revoked_at IS NULL AND session.expires_at > CURRENT_TIMESTAMP AND users.status = 'active' AND membership.status = 'active'`, [tenant.organizationId, tenant.projectId, tokenHash(token)]);
				if (!result.rows[0]) return undefined;
				await client.query('UPDATE qase_auth_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash(token)]);
				return actor(await selectUser(client, result.rows[0].user_id), tenant);
			});
		},
		async logout(token) { if (!token) return; await transaction(client => client.query('UPDATE qase_auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash(token)])); },
		async profile(userId) { return transaction(async client => { const user = await selectUser(client, userId); return user ? { ...safeUser(user), profile: user.profile } : undefined; }); },
		async updateProfile(userId, input) { return transaction(async client => { const user = await selectUser(client, userId); if (!user) throw new AuthError('Profile not found.', 'not_found', 404); const name = input?.displayName === undefined ? user.displayName : normalizeDisplayName(input.displayName); const profile = { ...defaultProfile(), ...user.profile, ...cleanProfilePatch(input) }; await client.query('UPDATE users SET display_name = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [userId, name]); await client.query(`INSERT INTO qase_user_profiles (user_id,organization_id,project_id,timezone,locale,preferences,onboarding_complete) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (user_id) DO UPDATE SET timezone=EXCLUDED.timezone,locale=EXCLUDED.locale,preferences=EXCLUDED.preferences,onboarding_complete=EXCLUDED.onboarding_complete,updated_at=CURRENT_TIMESTAMP`, [userId, tenant.organizationId, tenant.projectId, profile.timezone, profile.locale, profile.preferences, profile.onboardingComplete]); return { ...safeUser({ ...user, displayName: name }), profile }; }); },
		async listMemory(userId) { return transaction(async client => { const result = await client.query('SELECT id,key,value,scope,kind,created_at,updated_at FROM qase_memory_entries WHERE user_id = $1 ORDER BY updated_at DESC', [userId]); return result.rows.map(row => publicMemory({ id: row.id, key: row.key, value: row.value, scope: row.scope, kind: row.kind, createdAt: pgDate(row.created_at).toISOString(), updatedAt: pgDate(row.updated_at).toISOString() })); }); },
		async putMemory(userId, input) { const clean = cleanMemoryInput(input); return transaction(async client => { const existing = await client.query('SELECT id FROM qase_memory_entries WHERE user_id = $1 AND scope = $2 AND key = $3', [userId, clean.scope, clean.key]); if (!existing.rows.length) { const count = await client.query('SELECT COUNT(*)::int AS count FROM qase_memory_entries WHERE user_id = $1', [userId]); if (Number(count.rows[0]?.count ?? 0) >= 100) throw new AuthError('Memory is limited to 100 entries per account.', 'memory_limit', 400); } const result = await client.query(`INSERT INTO qase_memory_entries (id,user_id,organization_id,project_id,key,value,scope,kind) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id,scope,key) DO UPDATE SET value=EXCLUDED.value,kind=EXCLUDED.kind,updated_at=CURRENT_TIMESTAMP RETURNING id,key,value,scope,kind,created_at,updated_at`, [randomUUID(), userId, tenant.organizationId, tenant.projectId, clean.key, clean.value, clean.scope, clean.kind]); const row = result.rows[0]; return publicMemory({ id: row.id, key: row.key, value: row.value, scope: row.scope, kind: row.kind, createdAt: pgDate(row.created_at).toISOString(), updatedAt: pgDate(row.updated_at).toISOString() }); }); },
		async deleteMemory(userId, id) { if (!USER_ID.test(String(id))) throw new AuthError('Memory entry not found.', 'not_found', 404); return transaction(async client => (await client.query('DELETE FROM qase_memory_entries WHERE id = $1 AND user_id = $2', [id, userId])).rowCount === 1); },
		async check() { return transaction(async client => { await client.query('SELECT 1'); return { ready: true, backend: 'postgres' }; }); },
		async close() {}
	};
}

export function createLocalAuthService(options) { return createLocalDataStore(options); }
