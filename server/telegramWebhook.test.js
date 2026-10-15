import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApplication } from './app.js';
import { createInstanceAccess } from './instanceAccess.js';
const { createLocalApplicationServices } = await import('./localServices.js');

const TENANT = {
	organizationId: randomUUID(),
	projectId: randomUUID(),
	actorUserId: randomUUID(),
	actorEmail: 'webhook-owner@example.test',
	actorName: 'Webhook Owner'
};

function createFakeAuthService() {
	const tokens = new Map();
	return {
		authenticate: async token => tokens.get(token) ?? null,
		issue(role) {
			const token = `tok-${role}-${randomUUID()}`;
			tokens.set(token, { userId: TENANT.actorUserId, role, email: TENANT.actorEmail });
			return token;
		},
		listMemory: async () => [],
		check: async () => ({ ready: true })
	};
}

async function buildApp(extraEnvironment = {}) {
	const auth = createFakeAuthService();
	const services = createLocalApplicationServices({ tenantContext: TENANT, auth });
	await services.runs.load();
	const application = createApplication({
		services,
		access: createInstanceAccess({ tenantContext: TENANT }),
		authRequired: true,
		environment: { ...process.env, ...extraEnvironment }
	});
	const server = await new Promise(resolve => {
		const candidate = application.app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	const headers = {
		'content-type': 'application/json',
		cookie: `qase_session=${auth.issue('owner')}; qase_csrf=test-csrf`,
		'x-csrf-token': 'test-csrf'
	};
	return {
		application,
		origin: `http://127.0.0.1:${server.address().port}`,
		headers,
		close: () => new Promise(resolve => server.close(resolve))
	};
}

test('POST /webhooks/telegram always answers 200 — valid, invalid, or malformed', async () => {
	const app = await buildApp({ QASE_TELEGRAM_WEBHOOK_SECRET: 's3cret-token' });
	try {
		const post = (headers = {}, body = '{}') => fetch(`${app.origin}/webhooks/telegram`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body
		});
		assert.equal((await post({ 'x-telegram-bot-api-secret-token': 's3cret-token' }, '{"update_id":1}')).status, 200);
		assert.equal((await post({ 'x-telegram-bot-api-secret-token': 'wrong' }, '{"update_id":1}')).status, 200);
		assert.equal((await post({}, 'not json at all')).status, 200);
	} finally {
		await app.close();
	}
});

test('the old WhatsApp webhook is gone (404 via API fallback), Telegram webhook is NOT under /api auth', async () => {
	const app = await buildApp();
	try {
		const whatsapp = await fetch(`${app.origin}/webhooks/whatsapp`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}'
		});
		assert.equal(whatsapp.status, 404);
		// Telegram webhook reachable without QASE session auth (Telegram never
		// holds our session cookies).
		const telegram = await fetch(`${app.origin}/webhooks/telegram`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}'
		});
		assert.equal(telegram.status, 200);
	} finally {
		await app.close();
	}
});
