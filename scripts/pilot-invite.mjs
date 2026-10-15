#!/usr/bin/env node
/**
 * Operator CLI for pilot invites. Run from the workspace root:
 *
 *   node scripts/pilot-invite.mjs create --note "Alice from Acme"
 *   node scripts/pilot-invite.mjs list
 *
 * Authenticates with QASE_PILOT_INVITE_TOKEN? No — it logs in like any user
 * using the operator account from env, then hits the operator endpoints.
 * Requires: QASE_URL (default http://localhost:5173), and operator
 * credentials via QASE_OPERATOR_EMAIL / QASE_OPERATOR_PASSWORD.
 */
import { parseArgs } from 'node:util';

const base = process.env.QASE_URL ?? 'http://localhost:5173';
const email = process.env.QASE_OPERATOR_EMAIL;
const password = process.env.QASE_OPERATOR_PASSWORD;

function fail(message) {
	console.error(message);
	process.exit(1);
}

async function login() {
	if (!email || !password) fail('Set QASE_OPERATOR_EMAIL and QASE_OPERATOR_PASSWORD.');
	const response = await fetch(`${base}/api/auth/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email, password })
	});
	const cookie = response.headers.get('set-cookie') ?? '';
	const session = /qase_session=([^;]+)/.exec(cookie)?.[1];
	const csrf = /qase_csrf=([^;]+)/.exec(cookie)?.[1];
	const body = await response.json().catch(() => ({}));
	if (!response.ok || !session || !csrf) fail(`Login failed: ${body.error ?? response.status}`);
	return { session, csrf, body };
}

const { positionals } = parseArgs({ allowPositionals: true });
const [command] = positionals ?? [];
const noteIndex = process.argv.indexOf('--note');
const note = noteIndex >= 0 ? process.argv[noteIndex + 1] : '';

if (command === 'create') {
	const { session, csrf } = await login();
	const response = await fetch(`${base}/api/auth/invites`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: `qase_session=${session}`, 'x-csrf-token': csrf },
		body: JSON.stringify({ note })
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) fail(`Invite creation failed: ${body.error ?? response.status}`);
	console.log(body.code);
} else if (command === 'list') {
	const { session, csrf } = await login();
	const response = await fetch(`${base}/api/auth/invites`, {
		headers: { cookie: `qase_session=${session}`, 'x-csrf-token': csrf }
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) fail(`Invite listing failed: ${body.error ?? response.status}`);
	for (const invite of body.invites ?? []) {
		const status = invite.usedAt ? `used ${new Date(invite.usedAt).toISOString()}` : (invite.expiresAt < Date.now() ? 'expired' : 'unused');
		console.log(`${status.padEnd(36)} ${invite.code ?? '(consumed)'}  ${invite.note}`);
	}
} else {
	console.log('Usage: pilot-invite.mjs create [--note "who this is for"] | list');
	process.exit(command ? 1 : 0);
}
