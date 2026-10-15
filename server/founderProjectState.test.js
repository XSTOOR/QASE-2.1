import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	normalizeFounderProjectState,
	projectStateFromSession,
	reconcileSelections,
	createFounderProjectStateService
} from './founderProjectState.js';
import { createFounderState } from './founderService.js';

function finalizedFounderSession() {
	const session = {
		id: 'run-1', mode: 'founder', status: 'completed', ownerUserId: 'user-1',
		targetUrl: 'https://acme.test/',
		founder: {
			finalizedAt: '2026-10-05T10:00:00.000Z',
			scope: {
				target: { name: 'Acme', url: 'https://acme.test/' },
				productContext: { primaryGoal: 'Grow trials' },
				projectContext: { targetUrl: 'https://acme.test/' }
			},
			report: {
				generatedAt: '2026-10-05T10:00:00.000Z',
				recommendationSet: {
					setVersion: 1, generatedAt: '2026-10-05T10:00:00.000Z',
					recommendationIds: ['rec-1', 'rec-2', 'rec-3']
				},
				recommendations: [
					{ id: 'rec-1', title: 'A', priority: 1 },
					{ id: 'rec-2', title: 'B', priority: 2 },
					{ id: 'rec-3', title: 'C', priority: 3 }
				]
			}
		}
	};
	return session;
}

test('projectStateFromSession captures context, goals, set, and owner scoping', () => {
	const state = projectStateFromSession(finalizedFounderSession());
	assert.equal(state.ownerUserId, 'user-1');
	assert.equal(state.targetUrl, 'https://acme.test/');
	assert.equal(state.goals.primaryGoal, 'Grow trials');
	assert.equal(state.context.targetUrl, 'https://acme.test/');
	assert.equal(state.recommendationSet.setVersion, 1);
	assert.equal(state.recommendationSet.recommendations.length, 3);
	// No secrets path: nothing outside the whitelisted keys survives.
	assert.equal(Object.keys(state).includes('secrets'), false);
});

test('projectStateFromSession returns undefined for unfinalized sessions', () => {
	const session = finalizedFounderSession();
	session.founder.finalizedAt = undefined;
	delete session.founder.report;
	assert.equal(projectStateFromSession(session), undefined);
});

test('reconcileSelections keeps only ids present in the current set', () => {
	const state = normalizeFounderProjectState({
		...projectStateFromSession(finalizedFounderSession()),
		selections: ['rec-1', 'gone-9', 'rec-3']
	});
	const reconciled = reconcileSelections(state);
	assert.deepEqual(reconciled.selections, ['rec-1', 'rec-3']);
});

test('a failed regeneration must not erase the last good set — service semantics', async () => {
	const saved = [];
	let failNext = false;
	const service = createFounderProjectStateService({
		get: async () => saved[0],
		save: async state => {
			if (failNext) throw new Error('storage unavailable');
			saved[0] = state;
			return state;
		}
	});
	const first = normalizeFounderProjectState({ ...projectStateFromSession(finalizedFounderSession()), selections: ['rec-1'] });
	await service.save(first);

	// Regeneration succeeds → old set replaced, obsolete selections dropped.
	const regenerated = normalizeFounderProjectState({
		...projectStateFromSession(finalizedFounderSession()),
		recommendationSet: {
			setVersion: 2, generatedAt: '2026-10-06T10:00:00.000Z',
			recommendations: [{ id: 'new-1' }, { id: 'new-2' }, { id: 'new-3' }]
		},
		selections: ['rec-1'] // stale from the previous set
	});
	const savedRegenerated = await service.save(reconcileSelections(regenerated));
	assert.deepEqual(savedRegenerated.selections, []);

	// Regeneration fails → previous set and selections intact.
	failNext = true;
	const before = await service.get();
	await assert.rejects(service.save({ ...before, recommendationSet: undefined }), /storage unavailable/);
	const after = await service.get();
	assert.deepEqual(after, before);
	assert.equal(after.recommendationSet.setVersion, 2);
});

test('normalizeFounderProjectState bounds selections and size', () => {
	assert.throws(() => normalizeFounderProjectState({
		selections: ['x'.repeat(200)]
	}), /Founder selection 1/);
	assert.throws(() => normalizeFounderProjectState({
		goals: { primaryGoal: 'g'.repeat(500_000) },
		context: { blob: 'c'.repeat(500_000) }
	}), /1,?000,?000/);
});
