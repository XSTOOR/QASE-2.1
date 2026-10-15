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
	actorEmail: 'notify-owner@example.test',
	actorName: 'Notify Owner'
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

function makeNotifierHarness() {
	const dispatches = [];
	return {
		dispatches,
		notifier: {
			buildMessage: () => 'unused',
			async dispatchFeedbackNotification(feedback, context) {
				dispatches.push({ feedback: { ...feedback }, context: { ...context } });
			},
			getNotification: feedbackId => ({
				status: 'SENT',
				recipients: [
					{ chatId: '-1001110001111', state: 'sent', attempts: 1, messageId: 7 }
				]
			})
		}
	};
}

function makeSyncNotifier() {
	const dispatches = [];
	return {
		dispatches,
		notifier: {
			buildMessage: () => 'unused',
			dispatchFeedbackNotification(feedback, context) {
				// Deliberately NOT awaited inside dispatch.
				dispatches.push({ feedback: { ...feedback }, context: { ...context } });
				return new Promise(() => {}); // never resolves — proves the bounded wait
			},
			getNotification: () => ({ status: 'SENDING' })
		}
	};
}

function makeFailingNotifier() {
	const dispatches = [];
	return {
		dispatches,
		notifier: {
			buildMessage: () => 'unused',
			async dispatchFeedbackNotification(feedback, context) {
				dispatches.push({ feedback: { ...feedback }, context: { ...context } });
			},
			getNotification: () => ({
				status: 'FAILED',
				recipients: [
					{ chatId: '-1001110001111', state: 'failed', attempts: 3, lastError: 'Telegram API is unreachable.' }
				]
			})
		}
	};
}

function crashNotifier() {
	return {
		buildMessage: () => 'unused',
		dispatchFeedbackNotification() {
			return Promise.reject(new Error('notifier exploded'));
		}
	};
}

async function buildApp(notifier, extraEnvironment = {}) {
	const auth = createFakeAuthService();
	const services = createLocalApplicationServices({ tenantContext: TENANT, auth });
	await services.runs.load();
	const application = createApplication({
		services,
		access: createInstanceAccess({ tenantContext: TENANT }),
		authRequired: true,
		telegramNotifier: notifier,
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
		services,
		origin: `http://127.0.0.1:${server.address().port}`,
		headers,
		close: () => new Promise(resolve => server.close(resolve))
	};
}

async function finishedRun(services, { mode = 'qa', title = 'Notify target run' } = {}) {
	const session = await services.runs.create('https://notify-target.example/', {
		ownerUserId: TENANT.actorUserId,
		eventType: 'run.created'
	});
	session.mode = mode;
	session.title = title;
	session.targetUrl = 'https://notify-target.example/';
	await services.runs.setStatus(session, 'running');
	await services.runs.setStatus(session, 'done');
	return session;
}

test('POST /api/feedback dispatches after save with run context (id, mode, title, target, submittedAt)', async () => {
	const harness = makeNotifierHarness();
	const app = await buildApp(harness.notifier);
	try {
		const session = await finishedRun(app.services, { mode: 'sqa', title: 'Sweep of notify-target' });
		const response = await fetch(`${app.origin}/api/feedback`, {
			method: 'POST',
			headers: app.headers,
			body: JSON.stringify({ runId: session.id, rating: 4, comments: 'Solid SQA sweep.' })
		});
		assert.equal(response.status, 201);
		const record = await response.json();

		// Save-first: the record is durable in the store regardless of notifier.
		assert.equal((await app.services.feedback.forRun(session.id, TENANT.actorUserId))?.id, record.id);

		assert.equal(harness.dispatches.length, 1);
		const { feedback, context } = harness.dispatches[0];
		assert.equal(feedback.id, record.id);
		assert.equal(feedback.rating, 4);
		assert.equal(context.mode, 'sqa');
		assert.equal(context.title, 'Sweep of notify-target');
		assert.equal(context.targetUrl, 'https://notify-target.example/');
		assert.equal(typeof context.submittedAt, 'number');
	} finally {
		await app.close();
	}
});

test('improvement field travels end-to-end: POST body → stored record → dispatched feedback', async () => {
	const harness = makeNotifierHarness();
	const app = await buildApp(harness.notifier);
	try {
		const session = await finishedRun(app.services, { title: 'Improve-flow run' });
		const response = await fetch(`${app.origin}/api/feedback`, {
			method: 'POST',
			headers: app.headers,
			body: JSON.stringify({
				runId: session.id,
				rating: 5,
				comments: 'The testing was very smooth and the results were accurate.',
				improvement: 'The test execution report could provide more detailed information about failed test cases.'
			})
		});
		assert.equal(response.status, 201);
		const record = await response.json();
		assert.equal(record.improvement, 'The test execution report could provide more detailed information about failed test cases.');

		const stored = await app.services.feedback.forRun(session.id, TENANT.actorUserId);
		assert.equal(stored.improvement, record.improvement, 'store persists improvement');

		assert.equal(harness.dispatches.length, 1);
		assert.equal(harness.dispatches[0].feedback.improvement, record.improvement,
			'notifier receives the improvement field');

		// The message the notifier would build separates both fields.
		const { buildFeedbackMessage } = await import('./telegramNotifier.js');
		const message = buildFeedbackMessage(harness.dispatches[0].feedback, harness.dispatches[0].context);
		assert.match(message, /📝 User Feedback:\nThe testing was very smooth/);
		assert.match(message, /🔧 What should we improve\?\nThe test execution report could provide/);
	} finally {
		await app.close();
	}
});

test('dispatch metadata is authoritative: stored submittedAt + authenticated displayName, no Date.now()', async () => {
	const harness = makeNotifierHarness();
	const app = await buildApp(harness.notifier);
	try {
		const session = await finishedRun(app.services, { title: 'Metadata source run' });
		const before = Date.now();
		const response = await fetch(`${app.origin}/api/feedback`, {
			method: 'POST', headers: app.headers,
			body: JSON.stringify({ runId: session.id, rating: 4, comments: 'metadata check' })
		});
		assert.equal(response.status, 201);
		const record = await response.json();
		const after = Date.now();
		const { context } = harness.dispatches[0];
		// Timestamp: exactly the stored record's — never a fresh clock read.
		assert.equal(context.submittedAt, record.submittedAt);
		assert.ok(context.submittedAt >= before - 5 && context.submittedAt <= after + 5,
			'and it equals the real submission moment');
		// Identity: the authenticated session's user record, not a request-body
		// name and not undefined (which used to collapse to 'QASE user').
		assert.equal(context.submittedByName, TENANT.actorName);
	} finally {
		await app.close();
	}
});

test('improvement-only submissions dispatch with the improvement intact', async () => {
	const harness = makeNotifierHarness();
	const app = await buildApp(harness.notifier);
	try {
		const session = await finishedRun(app.services, { title: 'Improve-only run' });
		const response = await fetch(`${app.origin}/api/feedback`, {
			method: 'POST',
			headers: app.headers,
			body: JSON.stringify({
				runId: session.id,
				rating: 3,
				improvement: 'The automation should provide better failure explanations.'
			})
		});
		assert.equal(response.status, 201);
		const record = await response.json();
		assert.equal(record.comments, '');
		assert.equal(record.improvement, 'The automation should provide better failure explanations.');
		const { feedback } = harness.dispatches[0];
		assert.equal(feedback.improvement, 'The automation should provide better failure explanations.');
	} finally {
		await app.close();
	}
});

test('the HTTP response reports feedbackSaved + telegramSent truthfully (awaited result)', async () => {
	const harness = makeNotifierHarness();
	const app = await buildApp(harness.notifier);
	try {
		const session = await finishedRun(app.services);
		const response = await fetch(`${app.origin}/api/feedback`, {
			method: 'POST',
			headers: app.headers,
			body: JSON.stringify({ runId: session.id, rating: 5, comments: 'Fast.' })
		});
		assert.equal(response.status, 201);
		const body = await response.json();
		assert.equal(body.feedbackSaved, true);
		assert.equal(body.telegramSent, true);
		assert.equal(body.telegram.status, 'SENT');
		assert.equal(body.telegram.recipients[0].chatId, '-1001110001111');
		assert.equal(body.telegram.recipients[0].messageId, 7);
		// Backward compat: original record fields still present.
		assert.ok(body.id);
		assert.equal(body.rating, 5);
	} finally {
		await app.close();
	}
});

test('a stuck dispatch reports PENDING after the bounded wait — feedback saved', async () => {
	const harness = makeSyncNotifier(); // dispatch promise never resolves
	const app = await buildApp(harness.notifier, { QASE_TELEGRAM_RESULT_TIMEOUT_MS: '50' });
	try {
		const session = await finishedRun(app.services);
		const response = await fetch(`${app.origin}/api/feedback`, {
			method: 'POST',
			headers: app.headers,
			body: JSON.stringify({ runId: session.id, rating: 5, comments: 'Slow provider.' })
		});
		assert.equal(response.status, 201);
		const body = await response.json();
		assert.equal(body.feedbackSaved, true);
		assert.equal(body.telegramSent, false);
		assert.equal(body.telegram.status, 'PENDING');
		assert.match(body.telegram.message, /pending/);
		assert.equal(harness.dispatches.length, 1);
		assert.ok(await app.services.feedback.forRun(session.id, TENANT.actorUserId));
	} finally {
		await app.close();
	}
});

test('provider failure is reported, never swallowed — feedback still saved', async () => {
	const harness = makeFailingNotifier();
	const app = await buildApp(harness.notifier);
	try {
		const session = await finishedRun(app.services);
		const response = await fetch(`${app.origin}/api/feedback`, {
			method: 'POST',
			headers: app.headers,
			body: JSON.stringify({ runId: session.id, rating: 2, comments: 'Rough edges.' })
		});
		assert.equal(response.status, 201);
		const body = await response.json();
		assert.equal(body.feedbackSaved, true);
		assert.equal(body.telegramSent, false);
		assert.equal(body.telegram.status, 'FAILED');
		assert.match(body.telegram.message, /failed/);
		assert.ok(await app.services.feedback.forRun(session.id, TENANT.actorUserId));
	} finally {
		await app.close();
	}
});

test('feedback survives when the notifier rejects outright', async () => {
	const app = await buildApp(crashNotifier());
	try {
		const session = await finishedRun(app.services);
		const response = await fetch(`${app.origin}/api/feedback`, {
			method: 'POST',
			headers: app.headers,
			body: JSON.stringify({ runId: session.id, rating: 2, comments: 'Rough edges.' })
		});
		assert.equal(response.status, 201);
		const body = await response.json();
		assert.equal(body.feedbackSaved, true);
		assert.equal(body.telegramSent, false); // rejection never reads as success
		assert.equal(body.telegram.status, 'PENDING');
		assert.ok(await app.services.feedback.forRun(session.id, TENANT.actorUserId));
	} finally {
		await app.close();
	}
});

test('no dispatch on duplicate submission or validation failure', async () => {
	const harness = makeNotifierHarness();
	const app = await buildApp(harness.notifier);
	try {
		const session = await finishedRun(app.services);
		const submit = body => fetch(`${app.origin}/api/feedback`, {
			method: 'POST',
			headers: app.headers,
			body: JSON.stringify(body)
		});

		const first = await submit({ runId: session.id, rating: 5, comments: 'First.' });
		assert.equal(first.status, 201);

		const duplicate = await submit({ runId: session.id, rating: 1, comments: 'Second (dup).' });
		assert.equal(duplicate.status, 409);

		const unknownRun = await submit({ runId: randomUUID(), rating: 5, comments: 'No such run.' });
		assert.equal(unknownRun.status, 404);

		const secondRun = await finishedRun(app.services);
		const invalidRating = await submit({ runId: secondRun.id, rating: 'x', comments: 'Invalid rating.' });
		assert.equal(invalidRating.status, 400);

		assert.equal(harness.dispatches.length, 1); // exactly one, from the first submit
	} finally {
		await app.close();
	}
});

test('no notifier configured (undefined) → submissions behave exactly as before', async () => {
	const app = await buildApp(undefined);
	try {
		const session = await finishedRun(app.services);
		const response = await fetch(`${app.origin}/api/feedback`, {
			method: 'POST',
			headers: app.headers,
			body: JSON.stringify({ runId: session.id, rating: 3, comments: 'Okay.' })
		});
		assert.equal(response.status, 201);
	} finally {
		await app.close();
	}
});

test('invalid injected notifier shape is rejected at construction', () => {
	assert.throws(() => {
		createApplication({
			services: createLocalApplicationServices({ tenantContext: TENANT }),
			access: createInstanceAccess({ tenantContext: TENANT }),
			telegramNotifier: { nope: true }
		});
	}, /dispatchFeedbackNotification/);
});
