import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Single-use invite codes for pilot registration.
 *
 * The instance keeps production registration closed (anyone self-registering
 * could reach the shared model key). A controlled pilot needs a third state
 * between "closed" and "open to the world": the operator mints a code, hands
 * it to one beta user, and that user registers with it exactly once.
 *
 * Store conventions match the auth store: one JSON file, atomic tmp+rename,
 * mode 0600, serialized writes.
 */

const INVITES_FILE = path.join(process.cwd(), '.qase', 'invites.json');
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const CODE_PREFIX = 'qase-';
// Crockford base32 (no I, L, O, U) — unambiguous to read out and type.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_BODY_BYTES = 16; // ~25 chars -> 128 bits of entropy
const MAX_INVITES = 1000;
const NOTE_MAX = 200;

export class InviteError extends Error {
	constructor(message, code = 'invite_error', status = 400) {
		super(message);
		this.name = 'InviteError';
		this.code = code;
		this.status = status;
	}
}

function encodeCodeBody(bytes) {
	let bits = 0;
	let value = 0;
	let output = '';
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			output += CODE_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) output += CODE_ALPHABET[(value << (5 - bits)) & 31];
	return output;
}

function newCode() {
	return CODE_PREFIX + encodeCodeBody(randomBytes(CODE_BODY_BYTES));
}

function normalizeCode(value) {
	if (typeof value !== 'string') return '';
	return value.trim().toUpperCase().replace(/[^0-9A-Z-]/g, '');
}

function constantTimeEquals(a, b) {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

function validNote(value) {
	if (value === undefined || value === null) return '';
	const note = String(value).trim();
	if (note.length > NOTE_MAX) throw new InviteError('Invite note is too long.', 'invalid_note', 400);
	if (/[\u0000-\u001f\u007f]/.test(note)) throw new InviteError('Invite note is invalid.', 'invalid_note', 400);
	return note;
}

export function createInviteService({
	now = () => Date.now(),
	file = INVITES_FILE,
	ttlMs = DEFAULT_TTL_MS
} = {}) {
	const state = { loaded: false, data: { version: 1, invites: [] }, lock: Promise.resolve() };

	async function persist() {
		await fs.promises.mkdir(path.dirname(file), { recursive: true });
		const temporary = `${file}.${process.pid}.tmp`;
		await fs.promises.writeFile(temporary, JSON.stringify(state.data), { mode: 0o600 });
		await fs.promises.rename(temporary, file);
	}

	async function load() {
		if (state.loaded) return;
		try {
			const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
			if (parsed?.version === 1 && Array.isArray(parsed.invites)) state.data = parsed;
		} catch (error) {
			if (error?.code !== 'ENOENT') throw new Error('The invite store is unreadable.');
		}
		state.loaded = true;
	}

	function withLock(work) {
		const run = state.lock.then(work, work);
		state.lock = run.catch(() => undefined);
		return run;
	}

	/** Mint an invite. Returns the full code exactly once — it is the secret. */
	function create({ note, createdBy, ttlMilliseconds } = {}) {
		return withLock(async () => {
			await load();
			if (state.data.invites.length >= MAX_INVITES) {
				throw new InviteError('The invite store is full.', 'invite_limit', 400);
			}
			const invite = {
				code: newCode(),
				note: validNote(note),
				createdBy: typeof createdBy === 'string' ? createdBy : undefined,
				createdAt: now(),
				expiresAt: now() + (Number.isFinite(ttlMilliseconds) && ttlMilliseconds > 0 ? ttlMilliseconds : ttlMs),
				usedBy: undefined,
				usedAt: undefined
			};
			state.data.invites.push(invite);
			await persist();
			return { code: invite.code, note: invite.note, createdAt: invite.createdAt, expiresAt: invite.expiresAt };
		});
	}

	/**
	 * Consume a code for a registration. Atomic: a used or expired code
	 * fails; a valid code is marked used inside the same locked write that
	 * observed it unused. Errors are deliberately uniform so the endpoint
	 * gives probing clients no oracle beyond valid/invalid.
	 */
	function consume(rawCode, usedBy) {
		return withLock(async () => {
			await load();
			const code = normalizeCode(rawCode);
			const invite = state.data.invites.find(candidate => constantTimeEquals(normalizeCode(candidate.code), code));
			const alive = invite
				&& !invite.usedAt
				&& invite.expiresAt > now();
			if (!invite || !alive) {
				throw new InviteError('This invite code is not valid.', 'invalid_invite', 403);
			}
			invite.usedBy = typeof usedBy === 'string' ? usedBy : undefined;
			invite.usedAt = now();
			await persist();
			return { createdAt: invite.createdAt };
		});
	}

	/**
	 * Validate a code WITHOUT consuming it — lets the register route reject
	 * invalid/expired/used codes before creating an account, then consume only
	 * on successful registration so a failed signup doesn't burn the invite.
	 */
	function validate(rawCode) {
		return withLock(async () => {
			await load();
			const code = normalizeCode(rawCode);
			const invite = state.data.invites.find(candidate => constantTimeEquals(normalizeCode(candidate.code), code));
			const alive = invite
				&& !invite.usedAt
				&& invite.expiresAt > now();
			if (!invite || !alive) {
				throw new InviteError('This invite code is not valid.', 'invalid_invite', 403);
			}
			return { createdAt: invite.createdAt };
		});
	}

	/** Operator listing — codes are returned only for unused invites (already-used codes are dead secrets). */
	async function list() {
		await load();
		return state.data.invites.map(invite => ({
			code: invite.usedAt ? undefined : invite.code,
			note: invite.note,
			createdAt: invite.createdAt,
			expiresAt: invite.expiresAt,
			usedBy: invite.usedBy,
			usedAt: invite.usedAt
		}));
	}

	async function check() {
		await load();
		return { ready: true, invites: state.data.invites.length, used: state.data.invites.filter(invite => invite.usedAt).length };
	}

	/** Reserve durably before account creation. Failed account validation releases
	 * the reservation; a process crash leaves the code consumed (fail closed).
	 * The same lock covers validation, registration, and final admission.
	 */
	function redeem(rawCode, email, register) {
		return withLock(async () => {
			await load();
			const code = normalizeCode(rawCode);
			const invite = state.data.invites.find(candidate => constantTimeEquals(normalizeCode(candidate.code), code));
			if (!invite || invite.usedAt !== undefined || invite.expiresAt <= now()) {
				throw new InviteError('This invite code is not valid.', 'invalid_invite', 403);
			}
			invite.usedAt = now(); invite.usedBy = email;
			await persist();
			try { return await register(); }
			catch (error) {
				// Only validation failures known to precede account creation can
				// release a code. An I/O failure may occur after an account was
				// committed; keep that reservation consumed rather than admit twice.
				if (!['invalid_input', 'invalid_email', 'invalid_display_name', 'weak_password', 'email_taken'].includes(error?.code)) throw error;
				delete invite.usedAt; delete invite.usedBy;
				await persist();
				throw error;
			}
		});
	}

	return { create, validate, consume, redeem, list, check };
}
