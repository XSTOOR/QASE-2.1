/**
 * SMTP mail dispatch module for password-reset emails.
 *
 * Modes (QASE_MAIL_MODE):
 *  - `smtp`  — real delivery through an external SMTP relay (nodemailer).
 *  - `mock`  — dev/test only: messages land in an outbox file (.qase/outbox.json)
 *              so the reset flow is verifiable end to end without a live relay.
 *
 * Senders: administrators may configure TWO relay connections via environment
 * variables — a primary (Gmail: QASE_MAIL_*) and a secondary (company/Microsoft:
 * QASE_MAIL2_*). QASE_MAIL_SENDER selects the active one ('primary' default,
 * 'secondary'). Both use identical semantics and either can deliver to ANY
 * registered recipient domain — Gmail, Microsoft, Yahoo, company domains —
 * because an SMTP sender's relay domain is independent of recipient domains.
 *
 * Hard guarantees:
 *  1. Credentials come ONLY from environment variables (QASE_MAIL_* /
 *     QASE_MAIL2_*). They are never logged, never returned, never committed.
 *  2. Message bodies (which contain single-use reset links) are NEVER logged.
 *     Failures log a redacted one-liner: recipient + message id + error code.
 *  3. The mock outbox is a dev/test affordance. In production (NODE_ENV=
 *     production) the mock mode is refused: mail is dropped with one redacted
 *     log line so a missing SMTP configuration can never crash auth flows and
 *     can never leak a reset link into logs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const OUTBOX_FILE_NAME = path.join('.qase', 'outbox.json');
const OUTBOX_LIMIT = 50;

// Resolved lazily against the process cwd at read/write time (not at module
// import), so test fixtures that chdir into a temp directory stay hermetic.
function outboxFile() {
	return path.join(process.cwd(), OUTBOX_FILE_NAME);
}

/** Reads one sender connection block (prefix = 'QASE_MAIL' or 'QASE_MAIL2'). */
function senderConfig(environment, prefix) {
	const authMethod = String(environment[`${prefix}_AUTH_METHOD`] ?? '').trim().toLowerCase();
	return {
		host: String(environment[`${prefix}_HOST`] ?? '').trim(),
		port: Number(environment[`${prefix}_PORT`] ?? 587),
		user: String(environment[`${prefix}_USER`] ?? '').trim(),
		password: String(environment[`${prefix}_PASSWORD`] ?? ''),
		from: String(environment[`${prefix}_FROM`] ?? '').trim() || 'Qase <no-reply@qase.local>',
		/** Auth method: 'login' (user+password, default) or 'xoauth2'
		 *  (OAuth2 client credentials + refresh token — required when the
		 *  relay (e.g. Microsoft 365) has basic SMTP AUTH disabled). */
		authMethod: authMethod === 'xoauth2' ? 'xoauth2' : 'login',
		clientId: String(environment[`${prefix}_CLIENT_ID`] ?? '').trim(),
		clientSecret: String(environment[`${prefix}_CLIENT_SECRET`] ?? ''),
		refreshToken: String(environment[`${prefix}_REFRESH_TOKEN`] ?? '')
	};
}

function resolveMode(environment, senders) {
	const configured = String(environment.QASE_MAIL_MODE ?? '').trim().toLowerCase();
	if (configured === 'smtp' || configured === 'mock') return configured;
	// Default: smtp when any sender relay is actually configured, mock otherwise.
	return senders.some(sender => sender.host) ? 'smtp' : 'mock';
}

function resolveActiveSender(environment, senders) {
	const configured = String(environment.QASE_MAIL_SENDER ?? '').trim().toLowerCase();
	if (configured === 'secondary') return { sender: senders[1], name: 'secondary' };
	if (configured === 'primary') return { sender: senders[0], name: 'primary' };
	// Default: primary if configured, else secondary if that is the only one.
	if (senders[0].host) return { sender: senders[0], name: 'primary' };
	if (senders[1].host) return { sender: senders[1], name: 'secondary' };
	return { sender: senders[0], name: 'primary' };
}

async function readOutbox() {
	try {
		const parsed = JSON.parse(await fs.promises.readFile(outboxFile(), 'utf8'));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export function createMailer({ environment = process.env, logger, now = () => new Date() } = {}) {
	const senders = [senderConfig(environment, 'QASE_MAIL'), senderConfig(environment, 'QASE_MAIL2')];
	const mode = resolveMode(environment, senders);
	const active = resolveActiveSender(environment, senders);

	function info(message, meta) {
		if (logger?.info) logger.info(message, meta);
	}
	function warn(message, meta) {
		if (logger?.warn) logger.warn(message, meta);
		else console.warn(`[mailer] ${message}`, meta ?? '');
	}

	// Lazy import keeps the nodemailer dependency off the startup path when the
	// mock mode is active (dev/test default) and avoids bundling surprises.
	const transports = new Map();
	async function smtpTransport(sender) {
		if (!transports.has(sender)) {
			const nodemailer = await import('nodemailer');
			if (!sender.host) throw new Error(`SMTP delivery is requested but the ${active.name} sender's host variable is not configured.`);
			const base = {
				host: sender.host,
				port: sender.port,
				secure: sender.port === 465
			};
			if (sender.authMethod === 'xoauth2') {
				// OAuth2 XOAUTH2 (Microsoft 365 SMTP when basic AUTH is disabled):
				// an app registration (client id/secret) with SMTP.Send
				// application permission + a pre-provisioned refresh token mint
				// access tokens per connection; nodemailer rotates tokens as
				// they expire via its oauth2 provider.
				if (!sender.clientId || !sender.refreshToken) {
					throw new Error(`The ${active.name} sender is set to xoauth2 but ${sender.clientId ? 'the refresh token' : 'the client id'} is missing.`);
				}
				base.auth = {
					type: 'OAuth2',
					user: sender.user,
					clientId: sender.clientId,
					clientSecret: sender.clientSecret || undefined,
					refreshToken: sender.refreshToken
				};
			} else {
				base.auth = sender.user ? { user: sender.user, pass: sender.password } : undefined;
			}
			transports.set(sender, nodemailer.createTransport(base));
		}
		return transports.get(sender);
	}

	return {
		mode,
		/** Active sender name — 'primary' or 'secondary' (introspection only). */
		sender: active.name,
		/** Test/introspection helper — the outbox is dev/test-only. */
		async readOutbox() { return readOutbox(); },
		async send({ to, subject, text, html }) {
			const message = { to, subject, text, html, sentAt: now().toISOString() };
			if (mode === 'mock') {
				if (environment.NODE_ENV === 'production') {
					// Refuse to buffer reset links anywhere in production.
					warn('mail.dropped', { reason: 'mock mode is not available in production', to: '[redacted]', subject });
					return { delivered: false, mode };
				}
				const outbox = await readOutbox();
				outbox.push(message);
				try {
					await fs.promises.mkdir(path.dirname(outboxFile()), { recursive: true });
					await fs.promises.writeFile(outboxFile(), JSON.stringify(outbox.slice(-OUTBOX_LIMIT)), { mode: 0o600 });
				} catch {
					// The outbox is best-effort; in-memory delivery still counts.
				}
				info('mail.sent', { mode: 'mock', subject });
				return { delivered: true, mode };
			}
			try {
				const mailer = await smtpTransport(active.sender);
				await mailer.sendMail({ from: active.sender.from, to, subject, text, html });
				// Redacted: subject + active sender only. Never the body (reset links),
				// never credentials, never the recipient.
				info('mail.sent', { mode: 'smtp', sender: active.name, subject });
				return { delivered: true, mode, sender: active.name };
			} catch (error) {
				warn('mail.send_failed', { sender: active.name, subject, errorName: error?.name ?? 'Error', errorCode: error?.code ?? undefined });
				// error.code for relay failures (host unreachable, auth rejected);
				// otherwise the message (our own config errors are credential-free).
				return { delivered: false, mode, sender: active.name, error: error?.code ?? String(error?.message ?? error?.name).slice(0, 160) };
			}
		}
	};
}
