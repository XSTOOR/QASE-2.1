import test from 'node:test';
import assert from 'node:assert/strict';
import {
	buildFounderHandoffPayload,
	createFounderHandoffService,
	FounderHandoffError
} from './founderHandoff.js';

function recommendation(id, extra = {}) {
	return {
		id,
		title: `Recommendation ${id}`,
		priority: 'high',
		effort: 'small',
		proposedFeature: 'Feature for ' + id,
		whyItMatters: 'Why ' + id,
		intendedOutcome: 'Outcome ' + id,
		actions: ['Do A', 'Do B'],
		// schema-accurate: implementationScope is a bounded string; evidence
		// is carried as observation-id references
		implementationScope: 'Server: add POST /lead; Client: embed form on /pricing; no schema change.',
		dependencies: ['dep-x'],
		acceptanceCriteria: ['AC1', 'AC2'],
		evidenceObservationIds: ['obs-1', 'obs-2'],
		assumptions: [],
		...extra
	};
}

function savedState() {
	return {
		schemaVersion: 1,
		updatedAt: '2026-09-30T00:00:00.000Z',
		projectId: 'proj-1',
		targetUrl: 'https://example.test/app',
		context: { description: 'Demo app' },
		goals: { primaryGoal: 'grow signups', constraints: 'no redesign' },
		recommendationSet: {
			setVersion: 2,
			generatedAt: '2026-09-30T00:00:00.000Z',
			recommendations: [recommendation('rec-1'), recommendation('rec-2'), recommendation('rec-3')]
		},
		selections: ['rec-1', 'rec-3']
	};
}

test('buildFounderHandoffPayload includes only selected ids, ordered by set order', () => {
	const { payload, selected } = buildFounderHandoffPayload(savedState(), ['rec-3', 'rec-1']);
	assert.deepEqual(selected, ['rec-1', 'rec-3']);
	assert.equal(payload.source, 'founder');
	assert.equal(payload.schemaVersion, 1);
	assert.equal(payload.projectId, 'proj-1');
	assert.deepEqual(payload.ordered, ['rec-1', 'rec-3']);
	assert.equal(payload.implementationRequirements.length, 2);
	assert.equal(payload.implementationRequirements[0].order, 1);
	assert.equal(payload.implementationRequirements[0].recommendationId, 'rec-1');
	assert.equal(payload.implementationRequirements[1].order, 2);
	// full detail per item — enough to implement without guessing
	assert.equal(payload.implementationRequirements[0].title, 'Recommendation rec-1');
	assert.deepEqual(payload.implementationRequirements[0].acceptanceCriteria, ['AC1', 'AC2']);
	assert.deepEqual(payload.implementationRequirements[0].dependencies, ['dep-x']);
	assert.match(payload.implementationRequirements[0].implementationScope, /^Server: add POST/);
	assert.deepEqual(payload.implementationRequirements[0].evidence, ['obs-1', 'obs-2']);
	assert.ok(payload.implementationRequirements[0].proposedFeature.length > 0);
	assert.ok(payload.implementationRequirements[0].whyItMatters.length > 0);
	assert.ok(payload.implementationRequirements[0].intendedOutcome.length > 0);
	assert.ok(payload.implementationRequirements[0].priority);
	assert.ok(payload.implementationRequirements[0].effort);
	// product context + goals
	assert.deepEqual(payload.productContext, { description: 'Demo app' });
	assert.deepEqual(payload.goals, { primaryGoal: 'grow signups', constraints: 'no redesign' });
	// set reference
	assert.equal(payload.recommendationSet.setVersion, 2);
	assert.deepEqual(payload.recommendationSet.recommendationIds, ['rec-1', 'rec-3']);
	// dependencies/acceptance roll-up (deduplicated)
	assert.deepEqual(payload.dependencies, ['dep-x']);
	assert.deepEqual(payload.acceptanceCriteria, ['AC1', 'AC2', 'AC1', 'AC2']);
});

test('buildFounderHandoffPayload prefers trusted tenant projectId', () => {
	const { payload } = buildFounderHandoffPayload(savedState(), ['rec-1'], { projectId: 'tenant-trusted' });
	assert.equal(payload.projectId, 'tenant-trusted');
});

test('payload contains no secrets', () => {
	const state = savedState();
	state.context.apiKey = 'sk-supersecret';
	state.goals.password = 'hunter2';
	const { payload } = JSON.parse(JSON.stringify(buildFounderHandoffPayload(state, ['rec-1'])/* strip functions */));
	// rebuild raw for key assertions
	const raw = buildFounderHandoffPayload(state, ['rec-1']);
	assert.ok(!('apiKey' in raw.payload.productContext), 'apiKey key must be scrubbed');
	assert.ok(!('password' in raw.payload.goals), 'password key must be scrubbed');
	assert.ok(!JSON.stringify(raw.payload).includes('sk-'));
	assert.ok(!JSON.stringify(raw.payload).includes('hunter2'));
});

test('unknown ids are rejected', () => {
	assert.throws(
		() => buildFounderHandoffPayload(savedState(), ['rec-1', 'nope']),
		error => error instanceof FounderHandoffError && error.code === 'invalid_selection' && error.status === 400
	);
});

test('empty and missing selections are rejected', () => {
	assert.throws(() => buildFounderHandoffPayload(savedState(), []), FounderHandoffError);
	assert.throws(() => buildFounderHandoffPayload(savedState(), undefined), FounderHandoffError);
	assert.throws(() => buildFounderHandoffPayload(undefined, ['rec-1']),
		error => error.code === 'no_recommendation_set');
});

test('send delivers via the signed client and stores the returned reference', async () => {
	let saved;
	const deliveries = [];
	const state = savedState();
	const service = createFounderHandoffService({
		deliveryClient: {
			async deliver(target, payload, opts) {
				deliveries.push({ target, payload, opts });
				return { status: 202, reference: 'job-7f3' };
			}
		},
		target: '/founder-handoff',
		get: async () => saved ?? state,
		save: async next => { saved = next; return next; },
		tenantProjectId: 'tenant-1',
		now: () => '2026-09-30T01:00:00.000Z'
	});
	const result = await service.send(['rec-1', 'rec-3']);
	assert.equal(result.ok, true);
	assert.equal(result.handoff.status, 'succeeded');
	assert.equal(result.handoff.reference, 'job-7f3');
	assert.equal(result.handoff.upstreamStatus, 202);
	assert.deepEqual(result.handoff.selectedRecommendationIds, ['rec-1', 'rec-3']);
	// delivery used the existing signed client with an idempotency key
	assert.equal(deliveries.length, 1);
	assert.equal(deliveries[0].target, '/founder-handoff');
	assert.ok(deliveries[0].opts.idempotencyKey.startsWith('founder-handoff-'));
	// saved state keeps selections and records the handoff
	assert.equal(saved.handoff.status, 'succeeded');
	assert.deepEqual(saved.selections, ['rec-1', 'rec-3']);
});

test('duplicate submissions while pending are rejected with 409', async () => {
	let saved = {
		...savedState(),
		handoff: { status: 'pending', requestedAt: '2026-09-29T23:59:00.000Z', selectedRecommendationIds: ['rec-1'] }
	};
	const service = createFounderHandoffService({
		deliveryClient: { async deliver() { return { status: 200 }; } },
		target: '/t',
		get: async () => saved,
		save: async next => { saved = next; return next; },
		now: () => '2026-09-30T00:00:00.000Z' // 1 minute after the pending record — fresh
	});
	await assert.rejects(service.send(['rec-2']),
		error => error instanceof FounderHandoffError && error.code === 'handoff_pending' && error.status === 409);
});

test('long text fields are NOT truncated to 100 chars — schema bounds survive intact', () => {
	const longWhy = 'Why it matters: '.padEnd(400, 'x');
	const longScope = 'Scope: '.padEnd(3_000, 'y');
	const state = savedState();
	state.recommendationSet.recommendations[0] = {
		...state.recommendationSet.recommendations[0],
		whyItMatters: longWhy,
		implementationScope: longScope
	};
	const { payload } = buildFounderHandoffPayload(state, ['rec-1']);
	assert.equal(payload.implementationRequirements[0].whyItMatters, longWhy.trim());
	assert.equal(payload.implementationRequirements[0].implementationScope, longScope.trim());
});

test('a stale pending record (crashed process) expires and does not wedge the project', async () => {
	let saved = {
		...savedState(),
		handoff: { status: 'pending', requestedAt: '2026-09-01T00:00:00.000Z', selectedRecommendationIds: ['rec-1'] }
	};
	const service = createFounderHandoffService({
		deliveryClient: { async deliver() { return { status: 202, reference: 'job-after-crash' }; } },
		target: '/t',
		get: async () => saved,
		save: async next => { saved = next; return next; },
		now: () => '2026-09-30T00:00:00.000Z' // 29 days after the pending record
	});
	const result = await service.send(['rec-2']);
	assert.equal(result.ok, true);
	assert.equal(result.handoff.status, 'succeeded');
	assert.equal(result.handoff.reference, 'job-after-crash');
});

test('failed delivery preserves selections and records a failed handoff', async () => {
	let saved = savedState();
	const service = createFounderHandoffService({
		deliveryClient: { async deliver() { throw new Error('network down'); } },
		target: '/t',
		get: async () => saved,
		save: async next => { saved = next; return next; }
	});
	await assert.rejects(service.send(['rec-2']),
		error => error instanceof FounderHandoffError && error.status === 502);
	assert.equal(saved.handoff.status, 'failed');
	assert.equal(saved.selections.length, 2); // untouched
	assert.deepEqual(saved.handoff.selectedRecommendationIds, ['rec-2']);
});

test('unconfigured integration returns unavailable without claiming a build', async () => {
	let saved = savedState();
	const service = createFounderHandoffService({
		deliveryClient: undefined,
		target: undefined,
		get: async () => saved,
		save: async next => { saved = next; return next; }
	});
	assert.equal(service.configured, false);
	const result = await service.send(['rec-1']);
	assert.equal(result.ok, false);
	assert.equal(result.unavailable, true);
	assert.equal(result.handoff.status, 'unavailable');
	assert.ok(!/build (has )?start/i.test(result.handoff.message));
	// the payload is still fully built and ready for copy/export
	assert.equal(result.payload.implementationRequirements.length, 1);
	assert.deepEqual(result.payload.ordered, ['rec-1']);
	// build-only export path
	const payload = await service.build(['rec-1']);
	assert.equal(payload.source, 'founder');
});
