import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReportMarkdown, buildMatrixSectionMarkdown } from './report.js';

/** Minimal session shape for report generation. */
function sessionWith(overrides = {}) {
	return {
		id: 'run-1',
		title: 'Login workflow',
		targetUrl: 'https://example.test/login',
		createdAt: '2027-02-10T10:00:00.000Z',
		todos: [],
		findings: [],
		report: { verdict: 'pass', summary: 'ok' },
		...overrides
	};
}

test('buildMatrixSectionMarkdown: empty without session.matrixCoverage (non-matrix sessions unchanged)', () => {
	assert.equal(buildMatrixSectionMarkdown(sessionWith()), '');
	const markdown = buildReportMarkdown(sessionWith());
	assert.equal(markdown.includes('## Matrix coverage'), false);
});

test('buildMatrixSectionMarkdown: renders counts from the injected coverage snapshot', () => {
	const session = sessionWith({
		matrixRunId: 'matrix-1',
		matrixCoverage: {
			execution: {
				profilesRequested: 36, profilesExecuted: 34, passed: 31, failed: 3,
				notRun: 1, unavailable: 0, notSupported: 1, blocked: 0, error: 0
			},
			deviceCategories: [
				{ label: 'iPhone', requested: 6, executed: 6, covered: true, gapReason: null },
				{ label: 'Android tablets', requested: 6, executed: 0, covered: false, gapReason: 'NOT_SUPPORTED' }
			],
			browsers: [
				{ browser: 'chrome', requested: 6, executed: 6, covered: true, gapReason: null },
				{ browser: 'duckduckgo', requested: 6, executed: 0, covered: false,
					gapReason: 'DuckDuckGo is a mobile-only browser with no Playwright build.' }
			]
		}
	});
	const section = buildMatrixSectionMarkdown(session);
	assert.match(section, /Profiles requested 36 · executed 34 · passed 31 · failed 3/);
	assert.match(section, /not supported 1/);
	assert.match(section, /✓ iPhone — 6\/6 executed/);
	assert.match(section, /⚠ Android tablets — 0\/6 executed/);
	assert.match(section, /⚠ duckduckgo — 0\/6 executed — DuckDuckGo is a mobile-only browser with no Playwright build\./);
	// Full report embeds the section for matrix sessions only.
	const markdown = buildReportMarkdown(session);
	assert.match(markdown, /## Matrix coverage/);
	// Without the injection the same session type renders no section.
	assert.equal(buildReportMarkdown(sessionWith({ matrixRunId: 'matrix-1' })).includes('## Matrix coverage'), false);
});

test('buildMatrixSectionMarkdown: never implies a pass for unexecuted browsers', () => {
	const section = buildMatrixSectionMarkdown(sessionWith({
		matrixCoverage: {
			execution: { profilesRequested: 2, profilesExecuted: 0, passed: 0, failed: 0, notRun: 1, unavailable: 0, notSupported: 1, blocked: 0, error: 0 },
			deviceCategories: [],
			browsers: [{ browser: 'duckduckgo', requested: 2, executed: 0, covered: false, gapReason: 'runner unavailable' }]
		}
	}));
	assert.match(section, /executed 0 · passed 0/);
	assert.doesNotMatch(section, /✓/);
});

// ── #14942 Phase 4: per-configuration rows + totals in the report ──────

function matrixItemsSession(items) {
	return sessionWith({
		matrixRunId: 'matrix-42',
		matrixCoverage: {
			execution: { profilesRequested: items.length, profilesExecuted: 0, passed: 0, failed: 0, notRun: 0, unavailable: 0, notSupported: 0, blocked: 0, error: 0 },
			deviceCategories: [],
			browsers: []
		},
		matrixItems: items
	});
}

test('#14942: per-configuration rows with actual runner identity, evidence per row', () => {
	const items = [
		{ device: 'iPhone 15 Pro Max', os: 'iOS', osVersion: '17.0', browser: 'safari', browserVersion: '17.0',
			status: 'PASSED', verdict: 'pass', sessionId: 's1',
			runtimeFacts: { launchedEngine: 'webkit', executionType: 'browser_emulation' },
			artifactRefs: [{ artifactId: 'shot-1' }, { artifactId: 'shot-2' }], defects: [{ bugNumber: 'BUG-0001' }] },
		{ device: 'Galaxy A15', os: 'Android', osVersion: '13', browser: 'chrome', browserVersion: '151',
			status: 'FAILED', reason: 'One finding', runtimeFacts: { launchedEngine: 'chromium' }, artifactRefs: [], defects: [] }
	];
	const section = buildMatrixSectionMarkdown(matrixItemsSession(items));
	assert.match(section, /Planned 2 · completed 2 · passed 1 · failed 1 · blocked 0 · skipped 0 · cancelled 0 · coverage gaps 0/);
	assert.match(section, /\*\*PASSED\*\* iPhone 15 Pro Max · iOS · 17\.0 · safari · 17\.0 \(engine: webkit, execution: browser_emulation\) — 📎 2 🐞 1/);
	assert.match(section, /\*\*FAILED\*\* Galaxy A15 · Android · 13 · chrome · 151 \(engine: chromium\) — One finding/);
});

test('#14942: unexecuted items are coverage gaps with reasons — never passes', () => {
	const items = [
		{ device: 'MacBook Air M3', os: 'macOS', osVersion: '14', browser: 'duckduckgo', browserVersion: null,
			status: 'NOT_SUPPORTED', reason: 'No execution channel for DuckDuckGo' },
		{ device: 'iPhone 15 Pro', os: 'iOS', osVersion: '17.0', browser: 'chrome', browserVersion: '151',
			status: 'QUEUED', reason: null },
		// Hand-patched status without an execution must never count as passed.
		{ device: 'Windows Desktop', os: 'Windows', osVersion: '11', browser: 'edge', browserVersion: '130',
			status: 'PASSED', verdict: null, sessionId: null }
	];
	const section = buildMatrixSectionMarkdown(matrixItemsSession(items));
	// Totals honest: the fake PASSED is NOT counted as passed; NOT_SUPPORTED is
	// terminal (completed), the QUEUED item is the only coverage gap.
	assert.match(section, /Planned 3 · completed 2 · passed 0 · failed 0 · blocked 0 · skipped 0 · cancelled 0 · coverage gaps 1/);
	// Gap rows carry their reason (only non-terminal items are gaps;
	// NOT_SUPPORTED is terminal — an honest completed-with-reason row).
	assert.match(section, /⚠ iPhone 15 Pro · iOS · chrome · 151: queued/);
	assert.match(section, /\*\*NOT_SUPPORTED\*\* MacBook Air M3 · macOS · 14 · duckduckgo — No execution channel for DuckDuckGo/);
	// The unexecuted PASSED keeps its status label but is not counted.
	assert.match(section, /\*\*PASSED\*\* Windows Desktop/);
});

test('#14942: no matrixItems → no Configurations block (existing reports unchanged)', () => {
	const section = buildMatrixSectionMarkdown(sessionWith({
		matrixRunId: 'matrix-1',
		matrixCoverage: {
			execution: { profilesRequested: 4, profilesExecuted: 0, passed: 0, failed: 0, notRun: 4, unavailable: 0, notSupported: 0, blocked: 0, error: 0 },
			deviceCategories: [], browsers: []
		}
	}));
	assert.doesNotMatch(section, /\*\*Configurations\*\*/);
});
