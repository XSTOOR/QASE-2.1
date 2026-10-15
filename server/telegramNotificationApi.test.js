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
	actorEmail: 'notify-admin@example.test',
	actorName: 'Notify Admin'
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

const FEEDBACK = { id: '11111111-2222-4333-8444-555555555555', runId: 'abcd1234-0000-0000-0000-000000000000', rating: 4, comments: 'Solid run.' };
const FEEDBACK2 = { id: '22222222-3333-4444-8555-666666666666', runId: 'abcd1234-0000-0000-0000-000000000000', rating: 3, comments: 'Some gaps.' };

function harness(notifier) {
	return new Promise(resolve => {
		const auth = createFakeAuthService();
		const services = createLocalApplicationServices({ tenantContext: TENANT, auth });
		const application = createApplication({
			services,
			access: createInstanceAccess({ tenantContext: TENANT }),
			authRequired: true,
			telegramNotifier: notifier
		});
		const server = application.app.listen(0, '127.0.0.1', () => {
			const origin = `http://127.0.0.1:${server.address().port}`;
			const call = (role, path, init = {}) => {
				const token = auth.issue(role);
				return fetch(`${origin}${path}`, {
					...init,
					headers: {
						'content-type': 'application/json',
						cookie: `qase_session=${token}; qase_csrf=test-csrf`,
						'x-csrf-token': 'test-csrf',
						...(init.headers ?? {})
					}
				});
			};
			resolve({ origin, call, close: () => new Promise(done => server.close(done)), services, auth });
		});
	});
}

const RECORD_SENT = {
	notificationId: `TELEGRAM-${FEEDBACK.id}`,
	feedbackId: FEEDBACK.id,
	runId: FEEDBACK.runId,
	status: 'SENT',
	recipients: [{ chatId: '-1001110001111', state: 'sent', attempts: 1 }],
	createdAt: 1_000,
	updatedAt: 2_000
};

const RECORD_FAILED = {
	notificationId: `TELEGRAM-${FEEDBACK2.id}`,
	feedbackId: FEEDBACK2.id,
	runId: FEEDBACK2.runId,
	status: 'FAILED',
	recipients: [
		{ chatId: '-1001110001111', state: 'sent', attempts: 1 },
		{ chatId: '-1002220002222', state: 'failed', attempts: 3, upstreamStatus: 503, lastError: 'Telegram API returned a server error.' }
	],
	createdAt: 3_000,
	updatedAt: 4_000
};

test('GET /api/feedback/notifications lists records for admins only', async () => {
	const fx = await harness({
		buildMessage: () => '',
		dispatchFeedbackNotification: async () => {},
		listNotifications: (filter = {}) => [RECORD_SENT, RECORD_FAILED].filter(r =>
			(!filter.status || r.status === filter.status) && (!filter.feedbackId || r.feedbackId === filter.feedbackId)),
		getNotification: () => undefined,
		retryNotification: async () => ({ ok: false, reason: 'not_found' })
	});
	try {
		const admin = await fx.call('owner', '/api/feedback/notifications');
		assert.equal(admin.status, 200);
		const payload = await admin.json();
		assert.equal(payload.enabled, true);
		assert.equal(payload.notifications.length, 2);
		assert.ok(payload.note.includes('Telegram API acceptance'));

		const filtered = await fx.call('owner', '/api/feedback/notifications?status=FAILED');
		assert.equal((await filtered.json()).notifications.length, 1);

		const byFeedback = await fx.call('owner', `/api/feedback/notifications?feedbackId=${FEEDBACK.id}`);
		assert.equal((await byFeedback.json()).notifications.length, 1);

		const developer = await fx.call('developer', '/api/feedback/notifications');
		assert.equal(developer.status, 403);
	} finally {
		await fx.close();
	}
});

test('POST /api/feedback/notifications/:id/retry replays a FAILED notification', async () => {
	const retries = [];
	const fx = await harness({
		buildMessage: () => '',
		dispatchFeedbackNotification: async () => {},
		listNotifications: () => [RECORD_FAILED],
		getNotification: () => RECORD_FAILED,
		retryNotification: async id => {
			retries.push(id);
			return { ok: true, notification: { ...RECORD_FAILED, status: 'SENT' } };
		}
	});
	try {
		const response = await fx.call('owner', `/api/feedback/notifications/${RECORD_FAILED.notificationId}/retry`, { method: 'POST' });
		assert.equal(response.status, 200);
		const payload = await response.json();
		assert.equal(payload.status, 'SENT');
		assert.deepEqual(retries, [RECORD_FAILED.notificationId]);

		const developer = await fx.call('developer', `/api/feedback/notifications/${RECORD_FAILED.notificationId}/retry`, { method: 'POST' });
		assert.equal(developer.status, 403);
	} finally {
		await fx.close();
	}
});

test('retry guards map to 404/409 and never fake success', async () => {
	const fx = await harness({
		buildMessage: () => '',
		dispatchFeedbackNotification: async () => {},
		listNotifications: () => [],
		getNotification: () => undefined,
		retryNotification: async () => ({ ok: false, reason: 'not_found' })
	});
	try {
		const unknown = await fx.call('owner', '/api/feedback/notifications/TELEGRAM-none/retry', { method: 'POST' });
		assert.equal(unknown.status, 404);

		const alreadySent = await harness({
			buildMessage: () => '',
			dispatchFeedbackNotification: async () => {},
			listNotifications: () => [],
			getNotification: () => RECORD_SENT,
			retryNotification: async () => ({ ok: false, reason: 'already_sent' })
		});
		try {
			const conflict = await alreadySent.call('owner', `/api/feedback/notifications/${RECORD_SENT.notificationId}/retry`, { method: 'POST' });
			assert.equal(conflict.status, 409);
			assert.equal((await conflict.json()).reason, 'already_sent');
		} finally {
			await alreadySent.close();
		}
	} finally {
		await fx.close();
	}
});

test('disabled integration: listing reports enabled:false and retry returns 501 — feedback routes unaffected', async () => {
	const fx = await harness(undefined);
	try {
		const list = await fx.call('owner', '/api/feedback/notifications');
		assert.equal(list.status, 200);
		const payload = await list.json();
		assert.equal(payload.enabled, false);
		assert.deepEqual(payload.notifications, []);

		const retry = await fx.call('owner', '/api/feedback/notifications/x/retry', { method: 'POST' });
		assert.equal(retry.status, 501);

		const stats = await fx.call('owner', '/api/feedback/stats');
		assert.equal(stats.status, 200);
	} finally {
		await fx.close();
	}
});
