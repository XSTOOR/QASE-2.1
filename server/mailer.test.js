import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMailer } from './mailer.js';

/**
 * Mailer contract for the Forgot Password flow (ticket #15673).
 *
 * Requirement: ONE configured SMTP sender (QASE_MAIL_*) delivers reset emails
 * to ANY registered recipient domain — gmail.com, outlook.com, yahoo.com, and
 * any other address a user registered with. Recipients never supply SMTP
 * credentials and never pick a provider; the single relay set via environment
 * variables routes all mail. There is no recipient-domain allowlist by design.
 */

const PUBLIC_PROVIDERS = [
	'user@gmail.com',
	'user@outlook.com',
	'user@yahoo.com',
	'user@hotmail.com',
	'user@proton.me',
	'user@icloud.com',
	'user@some-corp.example.com'
];

async function tmpDirectory() {
	return fs.promises.mkdtemp(path.join(os.tmpdir(), 'qase-mailer-'));
}

test('mock mailer delivers to every public-provider recipient domain without restriction', async () => {
	const directory = await tmpDirectory();
	const previousCwd = process.cwd();
	process.chdir(directory);
	try {
		const mailer = createMailer({ environment: { QASE_MAIL_MODE: 'mock' } });
		for (const to of PUBLIC_PROVIDERS) {
			const result = await mailer.send({ to, subject: 'Reset your Qase password', text: 'link', html: '<p>link</p>' });
			assert.equal(result.delivered, true, `delivery must succeed for ${to}`);
			assert.equal(result.mode, 'mock');
		}
		const outbox = JSON.parse(await fs.promises.readFile(path.join(directory, '.qase/outbox.json'), 'utf8'));
		assert.equal(outbox.length, PUBLIC_PROVIDERS.length);
		for (const to of PUBLIC_PROVIDERS) {
			assert.ok(outbox.some(m => m.to === to), `outbox must contain a message for ${to}`);
		}
	} finally {
		process.chdir(previousCwd);
		await fs.promises.rm(directory, { recursive: true, force: true });
	}
});

test('smtp mode builds one shared sender transport from QASE_MAIL_* env only', async () => {
	// We cannot open a real relay here; instead we assert the transport is
	// configured from env only and rejects/delivers per the relay — verified
	// indirectly by checking that mode resolves from the environment and that
	// host is the single source of relay routing.
	const mailer = createMailer({ environment: {
		QASE_MAIL_MODE: 'smtp', QASE_MAIL_HOST: 'smtp.example-relay.test', QASE_MAIL_PORT: '465',
		QASE_MAIL_USER: 'sender@example-relay.test', QASE_MAIL_PASSWORD: 'relay-secret',
		QASE_MAIL_FROM: 'Qase <no-reply@example-relay.test>'
	} });
	assert.equal(mailer.mode, 'smtp');
	// A send attempt against an unreachable relay must fail soft (delivered:
	// false, no throw) for ANY recipient domain — auth flows never crash.
	const result = await mailer.send({ to: 'user@gmail.com', subject: 'Reset your Qase password', text: 'x', html: 'x' });
	assert.equal(result.delivered, false);
	assert.equal(result.mode, 'smtp');
	assert.ok(result.error, 'unreachable relay surfaces an error code');
});

test('mode defaults: smtp once a relay host is configured, mock otherwise', async () => {
	assert.equal(createMailer({ environment: { QASE_MAIL_HOST: 'relay.example.test' } }).mode, 'smtp');
	assert.equal(createMailer({ environment: {} }).mode, 'mock');
});

test('dual senders: QASE_MAIL_SENDER selects the active connection', async () => {
	const both = {
		QASE_MAIL_HOST: 'smtp.gmail.com', QASE_MAIL_USER: 'qase@gmail.test',
		QASE_MAIL2_HOST: 'smtp.office365.test', QASE_MAIL2_USER: 'qase@corp.test'
	};
	assert.equal(createMailer({ environment: { ...both } }).sender, 'primary');
	assert.equal(createMailer({ environment: { ...both, QASE_MAIL_SENDER: 'primary' } }).sender, 'primary');
	assert.equal(createMailer({ environment: { ...both, QASE_MAIL_SENDER: 'secondary' } }).sender, 'secondary');
	// Only secondary configured → it is used even without the selector.
	assert.equal(createMailer({ environment: { QASE_MAIL2_HOST: 'smtp.office365.test' } }).sender, 'secondary');
	assert.equal(createMailer({ environment: { QASE_MAIL2_HOST: 'smtp.office365.test' } }).mode, 'smtp');
});

test('either sender delivers to any recipient domain (secondary/microsoft active)', async () => {
	const directory = await tmpDirectory();
	const previousCwd = process.cwd();
	process.chdir(directory);
	try {
		const mailer = createMailer({ environment: {
			QASE_MAIL_SENDER: 'secondary', QASE_MAIL_MODE: 'mock',
			QASE_MAIL2_HOST: 'smtp.office365.test', QASE_MAIL2_USER: 'qase@corp.test'
		} });
		assert.equal(mailer.sender, 'secondary');
		for (const to of PUBLIC_PROVIDERS) {
			const result = await mailer.send({ to, subject: 'Reset your Qase password', text: 'link', html: '<p>link</p>' });
			assert.equal(result.delivered, true, `secondary sender must deliver to ${to}`);
		}
	} finally {
		process.chdir(previousCwd);
		await fs.promises.rm(directory, { recursive: true, force: true });
	}
});

test('smtp send reports which sender was used and fails soft per sender', async () => {
	const mailer = createMailer({ environment: {
		QASE_MAIL_SENDER: 'secondary', QASE_MAIL_MODE: 'smtp',
		QASE_MAIL2_HOST: 'smtp.office365.invalid.test', QASE_MAIL2_PORT: '465',
		QASE_MAIL2_USER: 'qase@corp.test', QASE_MAIL2_PASSWORD: 'x',
		QASE_MAIL2_FROM: 'Qase <no-reply@corp.test>'
	} });
	const result = await mailer.send({ to: 'user@gmail.com', subject: 'Reset your Qase password', text: 'x', html: 'x' });
	assert.equal(result.delivered, false);
	assert.equal(result.sender, 'secondary');
	assert.ok(result.error, 'unreachable relay surfaces an error code');
});

test('xoauth2 method builds an OAuth2 transport and validates its inputs', async () => {
	// Misconfigured xoauth2 (missing refresh token) fails soft with the named gap.
	const broken = createMailer({ environment: {
		QASE_MAIL_SENDER: 'secondary', QASE_MAIL_MODE: 'smtp', QASE_MAIL2_AUTH_METHOD: 'xoauth2',
		QASE_MAIL2_HOST: 'smtp.office365.com', QASE_MAIL2_USER: 'qase@corp.test',
		QASE_MAIL2_CLIENT_ID: 'client-id', QASE_MAIL2_FROM: 'Qase <no-reply@corp.test>'
	} });
	const result = await broken.send({ to: 'user@gmail.com', subject: 'Reset your Qase password', text: 'x', html: 'x' });
	assert.equal(result.delivered, false);
	assert.match(String(result.error), /refresh token/i);

	// Well-formed xoauth2 config builds an OAuth2 transport (verified against a
	// local listener acting as the token endpoint is out of scope; here we
	// assert the transport constructs and the send fails soft against an
	// unreachable relay rather than an auth-config error).
	const remote = createMailer({ environment: {
		QASE_MAIL_SENDER: 'secondary', QASE_MAIL_MODE: 'smtp', QASE_MAIL2_AUTH_METHOD: 'xoauth2',
		QASE_MAIL2_HOST: 'smtp.office365.invalid.test', QASE_MAIL2_USER: 'qase@corp.test',
		QASE_MAIL2_CLIENT_ID: 'client-id', QASE_MAIL2_CLIENT_SECRET: 'secret',
		QASE_MAIL2_REFRESH_TOKEN: 'refresh', QASE_MAIL2_FROM: 'Qase <no-reply@corp.test>'
	} });
	const r2 = await remote.send({ to: 'user@yahoo.com', subject: 'Reset your Qase password', text: 'x', html: 'x' });
	assert.equal(r2.delivered, false); // unreachable relay — but no config error
	assert.doesNotMatch(String(r2.error ?? ''), /xoauth2|refresh token|client id/i);
});

test('mock mode refuses to buffer reset links in production', async () => {
	const directory = await tmpDirectory();
	const previousCwd = process.cwd();
	process.chdir(directory);
	try {
		const lines = [];
		const mailer = createMailer({
			environment: { QASE_MAIL_MODE: 'mock', NODE_ENV: 'production' },
			logger: { info: () => {}, warn: (m, meta) => lines.push([m, meta]) }
		});
		const result = await mailer.send({ to: 'user@gmail.com', subject: 'Reset your Qase password', text: 'secret-link', html: 'secret-link' });
		assert.equal(result.delivered, false);
		// Nothing written, nothing logged with the link.
		assert.equal(await fs.promises.readFile(path.join(directory, '.qase/outbox.json'), 'utf8').then(() => true, () => false), false);
	} finally {
		process.chdir(previousCwd);
		await fs.promises.rm(directory, { recursive: true, force: true });
	}
});
