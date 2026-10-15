import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectFounderProjectContext } from './founderContext.js';
import { createFounderState } from './founderService.js';

test('detects nothing on a fresh project', () => {
	const detected = detectFounderProjectContext({ runs: [] });
	assert.equal(detected.targetUrl, undefined);
	assert.equal(detected.targetName, undefined);
	assert.equal(detected.studio, undefined);
	assert.equal(detected.previousFindings, undefined);
	assert.equal(detected.previousFounder, undefined);
});

test('prefills target URL from the most recent QA run', () => {
	const runs = [
		{ id: 'qa-old', mode: 'qa', targetUrl: 'https://old.example.test/', updatedAt: 100 },
		{ id: 'qa-new', mode: 'qa', targetUrl: 'https://new.example.test/', updatedAt: 200 }
	];
	const detected = detectFounderProjectContext({ runs });
	assert.equal(detected.targetUrl, 'https://new.example.test/');
	assert.equal(detected.targetName, 'new.example.test');
});

test('reuses Studio project metadata from signed QA runs only', () => {
	const runs = [{
		id: 'qa-studio', mode: 'qa', targetUrl: 'https://app.example.test/', updatedAt: 300,
		drytisIntegration: {
			project: { id: 'proj-1', name: 'Acme App', revision: 'r7' },
			projectContext: { description: 'A lead capture tool', applicationType: 'web app', frameworks: ['Astro'] }
		}
	}];
	const detected = detectFounderProjectContext({ runs });
	assert.equal(detected.studio.project.id, 'proj-1');
	assert.equal(detected.studio.project.name, 'Acme App');
	assert.equal(detected.studio.projectContext.description, 'A lead capture tool');
	assert.deepEqual(detected.studio.projectContext.frameworks, ['Astro']);
	assert.equal(detected.targetUrl, 'https://app.example.test/');
});

test('summarizes previous QA findings, bounded and newest first', () => {
	const runs = [{
		id: 'qa-1', mode: 'qa', targetUrl: 'https://app.example.test/', updatedAt: 100,
		findings: [
			{ title: 'Broken checkout CTA', severity: 'high', ts: 50 },
			{ title: 'Older signup bug', severity: 'medium', ts: 10 }
		]
	}];
	const detected = detectFounderProjectContext({ runs });
	assert.equal(detected.previousFindings.count, 2);
	assert.equal(detected.previousFindings.sample[0].title, 'Broken checkout CTA');
});

test('reuses the previous finalized Founder review context', () => {
	const runs = [{
		id: 'founder-1', mode: 'founder', updatedAt: 100,
		founder: {
			scope: { target: { name: 'Acme', url: 'https://acme.test/' }, productContext: { primaryGoal: 'Grow trials' } },
			finalizedAt: '2026-08-18T00:00:00.000Z'
		}
	}];
	const detected = detectFounderProjectContext({ runs });
	assert.equal(detected.previousFounder.runId, 'founder-1');
	assert.equal(detected.previousFounder.finalizedAt, '2026-08-18T00:00:00.000Z');
	// No QA target: fall back to the founder target URL.
	assert.equal(detected.targetUrl, 'https://acme.test/');
	assert.equal(detected.targetName, 'Acme');
});

test('createFounderState accepts and normalizes detected project context', () => {
	const state = createFounderState({
		authorizationConfirmed: true,
		target: { name: 'Acme', url: 'https://acme.test/' },
		productContext: {},
		projectContext: {
			targetUrl: 'https://acme.test/',
			studio: {
				project: { id: 'proj-1', name: 'Acme App', revision: 'r7' },
				projectContext: { description: 'desc', frameworks: ['Astro'] }
			},
			previousFindings: { count: 2, sample: ['Broken CTA [high]', 'Signup bug [medium]'] },
			previousFounder: { productContext: { primaryGoal: 'Grow trials' }, finalizedAt: '2026-08-18T00:00:00.000Z' }
		}
	});
	assert.equal(state.scope.projectContext.studio.project.id, 'proj-1');
	assert.equal(state.scope.projectContext.previousFindings.count, 2);
	assert.equal(state.scope.projectContext.previousFounder.primaryGoal, 'Grow trials');
});

test('createFounderState works with no advanced fields and no detected context', () => {
	const state = createFounderState({
		authorizationConfirmed: true,
		target: { name: 'Acme', url: 'https://acme.test/' }
	});
	assert.deepEqual(state.scope.productContext, {});
	assert.equal(state.scope.projectContext, undefined);
});
