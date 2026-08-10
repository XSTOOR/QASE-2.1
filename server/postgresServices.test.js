import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TENANT_CONTEXT } from './tenancy.js';
import { createPostgresApplicationServices } from './postgresServices.js';

const FIRST_ID = '6bf078e0-20df-48c3-a6f8-eb74ca14b9e1';
const SECOND_ID = '08ddf3b0-4499-4101-a20f-d87d3eebcd52';

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((accept, decline) => {
		resolve = accept;
		reject = decline;
	});
	return { promise, resolve, reject };
}

function session(overrides = {}) {
	return {
		id: FIRST_ID,
		title: 'First run',
		createdAt: 100,
		updatedAt: 100,
		status: 'idle',
		targetUrl: undefined,
		messages: [],
		activities: [],
		findings: [],
		todos: [],
		report: undefined,
		pendingQuestion: undefined,
		contextUsage: undefined,
		secretNames: [],
		...overrides
	};
}

function createFakeRepository(options = {}) {
	const state = {
		bootstrapCalls: 0,
		loadCalls: 0,
		createCalls: [],
		saveCalls: [],
		deleteCalls: [],
		checkCalls: 0,
		closeCalls: 0,
		createImplementation: undefined,
		saveImplementation: undefined,
		deleteImplementation: undefined
	};
	const repository = {
		async bootstrapTenant() {
			state.bootstrapCalls += 1;
			return {
				ready: true,
				organizationId: DEFAULT_TENANT_CONTEXT.organizationId,
				projectId: DEFAULT_TENANT_CONTEXT.projectId,
				actorUserId: '5a908fab-5598-4265-81f0-f36c02ca7699'
			};
		},
		async loadAll() {
			state.loadCalls += 1;
			return structuredClone(options.rows ?? []);
		},
		async create(value, metadata) {
			state.createCalls.push({ session: structuredClone(value), metadata: structuredClone(metadata) });
			if (state.createImplementation) return state.createImplementation(value, metadata);
			return { version: 1, updatedAt: value.updatedAt };
		},
		async save(value, metadata) {
			state.saveCalls.push({ session: structuredClone(value), metadata: structuredClone(metadata) });
			if (state.saveImplementation) return state.saveImplementation(value, metadata);
			return { version: Number(metadata.expectedVersion) + 1, updatedAt: value.updatedAt };
		},
		async delete(id, metadata) {
			state.deleteCalls.push({ id, metadata: structuredClone(metadata) });
			if (state.deleteImplementation) return state.deleteImplementation(id, metadata);
			return true;
		},
		async check() {
			state.checkCalls += 1;
			return options.check ?? {
				ready: true,
				organizationId: DEFAULT_TENANT_CONTEXT.organizationId,
				projectId: DEFAULT_TENANT_CONTEXT.projectId
			};
		},
		async close() {
			state.closeCalls += 1;
		}
	};
	return { repository, state };
}

async function flushAsyncStart() {
	await Promise.resolve();
	await Promise.resolve();
}

test('create, save, and delete await repository durability before visible publication or removal', async () => {
	const fake = createFakeRepository();
	const createGate = deferred();
	const saveGate = deferred();
	const deleteGate = deferred();
	let creatingSession;
	fake.state.createImplementation = value => {
		creatingSession = value;
		return createGate.promise;
	};
	fake.state.saveImplementation = () => saveGate.promise;
	fake.state.deleteImplementation = () => deleteGate.promise;
	const services = createPostgresApplicationServices({
		repository: fake.repository,
		tenantContext: DEFAULT_TENANT_CONTEXT,
		now: () => 200
	});
	await services.runs.load();

	const createPromise = services.runs.create('Durable run');
	await flushAsyncStart();
	assert.ok(creatingSession);
	const events = [];
	const unsubscribe = services.events.subscribe(creatingSession.id, event => events.push(event));
	assert.equal(events.length, 0);
	assert.equal(await services.runs.get(creatingSession.id), undefined);

	createGate.resolve({ version: 1, updatedAt: 201 });
	const created = await createPromise;
	assert.equal(created.title, 'Durable run');
	assert.equal(created.updatedAt, 201);
	assert.equal(events.length, 1);

	const statusPromise = services.runs.setStatus(created, 'running', 'Started');
	await flushAsyncStart();
	assert.equal(events.length, 1, 'save event must wait for repository commit');
	saveGate.resolve({ version: 2, updatedAt: 202 });
	await statusPromise;
	assert.equal(created.updatedAt, 202);
	assert.equal(events.length, 2);
	assert.equal(events.at(-1).type, 'status');

	let deleteSettled = false;
	const deletePromise = services.runs.delete(created.id);
	void deletePromise.finally(() => {
		deleteSettled = true;
	});
	await flushAsyncStart();
	assert.equal(deleteSettled, false);
	assert.equal((await services.runs.get(created.id)).id, created.id);
	deleteGate.resolve(true);
	assert.equal(await deletePromise, true);
	assert.equal(await services.runs.get(created.id), undefined);
	unsubscribe();
});

test('failed save restores the last committed aggregate and publishes nothing', async () => {
	const original = session({
		messages: [{ id: 'committed-message', ts: 90, role: 'user', text: 'Committed' }]
	});
	const fake = createFakeRepository({ rows: [{ session: original, version: 7 }] });
	const failure = new Error('serialization conflict');
	fake.state.saveImplementation = async () => {
		throw failure;
	};
	const services = createPostgresApplicationServices({
		repository: fake.repository,
		tenantContext: DEFAULT_TENANT_CONTEXT,
		now: () => 300
	});
	await services.runs.load();
	const loaded = await services.runs.get(FIRST_ID);
	const events = [];
	const unsubscribe = services.events.subscribe(FIRST_ID, event => events.push(event));

	await assert.rejects(
		services.runs.addMessage(loaded, { role: 'agent', text: 'Must roll back' }),
		failure
	);
	assert.deepEqual(loaded, original);
	assert.equal(events.length, 0);
	assert.equal(fake.state.saveCalls.length, 1);
	unsubscribe();
});

test('loaded summaries preserve newest-first ordering and exact child counts', async () => {
	const older = session({
		id: FIRST_ID,
		title: 'Older',
		updatedAt: 400,
		messages: [{ id: 'm1', ts: 1, role: 'user', text: 'One' }],
		findings: [{ id: 'f1' }, { id: 'f2' }]
	});
	const newer = session({
		id: SECOND_ID,
		title: 'Newer',
		createdAt: 200,
		updatedAt: 500,
		messages: [
			{ id: 'm2', ts: 2, role: 'user', text: 'Two' },
			{ id: 'm3', ts: 3, role: 'agent', text: 'Three' }
		],
		findings: [{ id: 'f3' }]
	});
	const fake = createFakeRepository({
		rows: [{ session: older, version: 1 }, { session: newer, version: 4 }]
	});
	const services = createPostgresApplicationServices({
		repository: fake.repository,
		tenantContext: DEFAULT_TENANT_CONTEXT
	});
	await services.runs.load();

	const summaries = await services.runs.list();
	assert.deepEqual(summaries.map(item => item.id), [SECOND_ID, FIRST_ID]);
	assert.deepEqual(summaries.map(item => [item.messageCount, item.findingCount]), [[2, 1], [1, 2]]);
	assert.equal(summaries[0].messages, undefined);
	assert.equal(summaries[0].findings, undefined);
});

test('load recovery interrupts active runs, clears pending input and all secret names', async () => {
	const running = session({
		id: FIRST_ID,
		status: 'running',
		pendingQuestion: { question: 'Should be cleared?' },
		secretNames: ['QA_PASSWORD']
	});
	const waiting = session({
		id: SECOND_ID,
		status: 'awaiting_input',
		pendingQuestion: { question: 'Continue?' },
		secretNames: ['QA_USERNAME', 'QA_PASSWORD']
	});
	const fake = createFakeRepository({
		rows: [{ session: running, version: 2 }, { session: waiting, version: 5 }]
	});
	const services = createPostgresApplicationServices({
		repository: fake.repository,
		tenantContext: DEFAULT_TENANT_CONTEXT,
		now: () => 600
	});
	await services.runs.load();

	for (const id of [FIRST_ID, SECOND_ID]) {
		const recovered = await services.runs.get(id);
		assert.equal(recovered.status, 'interrupted');
		assert.equal(recovered.pendingQuestion, undefined);
		assert.deepEqual(recovered.secretNames, []);
	}
	assert.equal(
		fake.state.saveCalls.every(call => call.session.secretNames.length === 0),
		true,
		'recovery persistence must never retain stale secret names'
	);
});

test('tenant context is exposed read-only, readiness delegates, and close is idempotent', async () => {
	const fake = createFakeRepository();
	const services = createPostgresApplicationServices({
		repository: fake.repository,
		tenantContext: DEFAULT_TENANT_CONTEXT
	});
	await services.runs.load();

	assert.deepEqual(services.tenantContext, DEFAULT_TENANT_CONTEXT);
	assert.equal(Object.isFrozen(services.tenantContext), true);
	const readiness = await services.readiness.check();
	assert.equal(readiness.ready, true);
	assert.equal(fake.state.checkCalls, 1);

	await Promise.all([
		services.lifecycle.close(),
		services.lifecycle.close(),
		services.lifecycle.close()
	]);
	await services.lifecycle.close();
	assert.equal(fake.state.closeCalls, 1);
});
