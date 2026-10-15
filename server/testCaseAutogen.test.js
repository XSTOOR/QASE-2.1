import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	autogenSettingsFromEnv,
	normalizeGeneratedCase,
	extractCaseDrafts,
	buildGenerationContext,
	buildFallbackCases,
	createTestCaseAutogen
} from './testCaseAutogen.js';
import { createTestCaseService, createLocalTestCaseBackend } from './testCaseService.js';

function tempBackend() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-autogen-'));
	return createTestCaseService(
		createLocalTestCaseBackend({ stateDir: dir, stateFile: path.join(dir, 'test-cases.json') })
	);
}

function completedSession(overrides = {}) {
	return {
		id: 'sess-abcdef12-3333',
		status: 'done',
		targetUrl: 'https://shop.example.com/checkout',
		report: { verdict: 'pass_with_issues', summary: 'Checkout works; slow search.' },
		todos: [
			{ text: 'Add an item to the cart', status: 'done' },
			{ text: 'Complete checkout with a card', status: 'done' }
		],
		findings: [
			{
				title: 'Search takes over five seconds',
				severity: 'high',
				actual: 'Results took 6s',
				expected: 'Results under 2s',
				steps: ['Open the shop', 'Search for "shoes"']
			}
		],
		environmentSnapshot: { device: 'Pixel 8', browser: 'Chrome', browserVersion: '138' },
		...overrides
	};
}

const LLM_OK = () => async () => ({
	ok: true,
	json: async () => ({
		choices: [{ message: { content: JSON.stringify({
			cases: [
				{
					title: 'Add an item to the cart and verify the cart badge updates',
					description: 'Covers the cart flow exercised during the run.',
					steps: ['Open https://shop.example.com/checkout', 'Add any item to the cart', 'Check the cart badge'],
					expected: 'The cart badge count increases by one.',
					tags: ['cart', 'AUTO']
				}
			]
		}) } }]
	})
});

describe('autogenSettingsFromEnv', () => {
	test('enabled by default with defaults', () => {
		const settings = autogenSettingsFromEnv({});
		assert.equal(settings.enabled, true);
		assert.equal(settings.maxCases, 5);
		assert.equal(settings.fromCases, false);
	});
	test('off flag disables', () => {
		for (const value of ['false', '0', 'off', 'no']) {
			assert.equal(autogenSettingsFromEnv({ QASE_AUTOGEN_TESTCASES: value }).enabled, false);
		}
	});
	test('max cases clamped to 1..20', () => {
		assert.equal(autogenSettingsFromEnv({ QASE_AUTOGEN_MAX_CASES: '3' }).maxCases, 3);
		assert.equal(autogenSettingsFromEnv({ QASE_AUTOGEN_MAX_CASES: '500' }).maxCases, 20);
		assert.equal(autogenSettingsFromEnv({ QASE_AUTOGEN_MAX_CASES: 'nonsense' }).maxCases, 5);
	});
});

describe('extractCaseDrafts', () => {
	test('parses a plain array', () => {
		assert.deepEqual(extractCaseDrafts('[{"title":"A"}]'), [{ title: 'A' }]);
	});
	test('parses a fenced object with cases key', () => {
		const text = 'Here you go:\n```json\n{"cases":[{"title":"B"}]}\n```\nDone.';
		assert.deepEqual(extractCaseDrafts(text), [{ title: 'B' }]);
	});
	test('parses an array embedded in prose', () => {
		const text = 'Sure! [{"title":"C"}] — hope that helps.';
		assert.deepEqual(extractCaseDrafts(text), [{ title: 'C' }]);
	});
	test('returns empty on garbage', () => {
		assert.deepEqual(extractCaseDrafts('not json at all'), []);
		assert.deepEqual(extractCaseDrafts(''), []);
	});
});

describe('normalizeGeneratedCase', () => {
	test('clamps and tags auto provenance', () => {
		const runTag = 'run-sess-abc';
		const normalized = normalizeGeneratedCase({
			title: `  ${'x'.repeat(400)}  `,
			steps: ['  Open the app  ', '', '  '.repeat(600) + 'long step', ...Array.from({ length: 60 }, (_, i) => `s${i}`)],
			tags: ['Auto', 'RUN-SESSABCD', 'Cart'],
			environmentIds: ['env-1']
		}, { runTag, sourceRunId: 'sess-abcdef12', sourceUrl: 'https://example.com' });
		assert.ok(normalized.title.length <= 300);
		assert.ok(normalized.steps.length <= 50);
		assert.equal(normalized.source, 'auto');
		assert.equal(normalized.sourceRunId, 'sess-abcdef12');
		assert.equal(normalized.tags[0], 'auto');
		assert.ok(normalized.tags.includes(runTag));
		assert.ok(!normalized.tags.includes('run-sess-abc'.toUpperCase()));
	});
	test('rejects drafts without a title', () => {
		assert.equal(normalizeGeneratedCase({ steps: ['a'] }, { runTag: 'r', sourceRunId: 'x' }), null);
		assert.equal(normalizeGeneratedCase(null, { runTag: 'r', sourceRunId: 'x' }), null);
	});
});

describe('buildFallbackCases', () => {
	test('one case per todo plus regression guard for high findings', () => {
		const context = buildGenerationContext(completedSession());
		const cases = buildFallbackCases(context, 5);
		assert.equal(cases.length, 3);
		assert.ok(cases[0].title.startsWith('Regression: '));
		assert.ok(cases[2].title.startsWith('Verify fix: '));
		assert.ok(cases[2].tags.includes('bug'));
	});
	test('caps at maxCases', () => {
		const context = buildGenerationContext(completedSession({
			todos: Array.from({ length: 10 }, (_, i) => ({ text: `todo ${i}`, status: 'done' }))
		}));
		assert.equal(buildFallbackCases(context, 2).length, 2);
	});
});

describe('createTestCaseAutogen', () => {
	test('generates cases from an LLM response and stores them', async () => {
		const testCases = tempBackend();
		const engine = createTestCaseAutogen({
			testCases, fetchImpl: LLM_OK(), config: { provider: 'custom', apiKey: 'k', baseUrl: 'https://gw.test/v1', model: 'm' }
		});
		const result = await engine.generateForSession(completedSession());
		assert.equal(result.created.length, 1);
		assert.equal(result.path, 'llm');
		const [record] = result.created;
		assert.equal(record.source, 'auto');
		assert.equal(record.sourceRunId, 'sess-abcdef12-3333');
		assert.ok(record.caseNumber.startsWith('TC-'));
		assert.ok(record.tags.includes('auto'));
		assert.ok(record.tags.includes('run-sess-abc'));
	});

	test('falls back to templates when the LLM fails', async () => {
		const testCases = tempBackend();
		const engine = createTestCaseAutogen({
			testCases,
			fetchImpl: async () => { throw new Error('network down'); },
			config: { provider: 'custom', apiKey: 'k', baseUrl: 'https://gw.test/v1', model: 'm' }
		});
		const result = await engine.generateForSession(completedSession());
		assert.equal(result.path, 'fallback');
		assert.ok(result.created.length >= 2);
	});

	test('uses templates when no API key is configured', async () => {
		const testCases = tempBackend();
		const engine = createTestCaseAutogen({ testCases, fetchImpl: LLM_OK(), config: { provider: 'custom', apiKey: '', baseUrl: '', model: '' } });
		const result = await engine.generateForSession(completedSession());
		assert.equal(result.path, 'fallback');
		assert.ok(result.created.length >= 1);
	});

	test('disabled setting produces nothing', async () => {
		const testCases = tempBackend();
		const engine = createTestCaseAutogen({
			testCases, fetchImpl: LLM_OK(), config: {}, settings: autogenSettingsFromEnv({ QASE_AUTOGEN_TESTCASES: 'off' })
		});
		const result = await engine.generateForSession(completedSession());
		assert.deepEqual(result.created, []);
		assert.equal(result.skipped, 'disabled');
	});

	test('runs launched from a test case are skipped unless flagged', async () => {
		const testCases = tempBackend();
		const session = completedSession({ testCaseSnapshot: { caseNumber: 'TC-0001', title: 'Authored case' } });
		const engine = createTestCaseAutogen({ testCases, fetchImpl: LLM_OK(), config: {} });
		assert.equal((await engine.generateForSession(session)).skipped, 'from-test-case');
		const flagged = createTestCaseAutogen({
			testCases, fetchImpl: LLM_OK(), config: {}, settings: autogenSettingsFromEnv({ QASE_AUTOGEN_FROM_CASES: 'true' })
		});
		assert.equal((await flagged.generateForSession(session)).created.length >= 1, true);
	});

	test('a run never generates the same title twice (idempotent)', async () => {
		const testCases = tempBackend();
		const engine = createTestCaseAutogen({ testCases, fetchImpl: LLM_OK(), config: {} });
		const first = await engine.generateForSession(completedSession());
		const second = await engine.generateForSession(completedSession());
		assert.equal(first.created.length >= 1, true);
		assert.equal(second.created.length, 0);
		assert.equal(second.skipped, 'already-generated');
	});

	test('failed and report-less runs generate nothing', async () => {
		const testCases = tempBackend();
		const engine = createTestCaseAutogen({ testCases, fetchImpl: LLM_OK(), config: {} });
		assert.equal((await engine.generateForSession(completedSession({ status: 'idle' }))).skipped, 'run-not-complete');
		assert.equal((await engine.generateForSession(completedSession({ report: null }))).skipped, 'no-report');
		assert.equal((await engine.generateForSession(completedSession({ todos: [], findings: [], report: { verdict: 'pass' } }))).skipped, 'nothing-to-generate');
	});

	test('garbage LLM JSON falls back to templates without crashing', async () => {
		const testCases = tempBackend();
		const engine = createTestCaseAutogen({
			testCases,
			fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'I cannot do that in JSON, sorry!' } }] }) }),
			config: { provider: 'custom', apiKey: 'k', baseUrl: 'https://gw.test/v1', model: 'm' }
		});
		const result = await engine.generateForSession(completedSession());
		assert.equal(result.path, 'fallback');
		assert.ok(result.created.length >= 1);
	});

	test('HTTP error from the model endpoint falls back', async () => {
		const testCases = tempBackend();
		const engine = createTestCaseAutogen({
			testCases,
			fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
			config: { provider: 'custom', apiKey: 'k', baseUrl: 'https://gw.test/v1', model: 'm' }
		});
		const result = await engine.generateForSession(completedSession());
		assert.equal(result.path, 'fallback');
	});

	test('LLM timeout is bounded by the configured timeout', async () => {
		const testCases = tempBackend();
		let observed;
		const engine = createTestCaseAutogen({
			testCases,
			fetchImpl: (_url, init) => {
				observed = init?.signal;
				return new Promise(() => {}); // never resolves
			},
			config: { provider: 'custom', apiKey: 'k', baseUrl: 'https://gw.test/v1', model: 'm' },
			settings: autogenSettingsFromEnv({ QASE_AUTOGEN_TIMEOUT_MS: '50' })
		});
		const result = await engine.generateForSession(completedSession());
		assert.ok(observed);
		assert.equal(result.path, 'fallback');
	});
});
