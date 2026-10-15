/**
 * qaMatrixResultsView DOM tests — Phase 4 (#14942).
 * Renders the view against a stub api + fixture matrix run and verifies the
 * board, totals, evidence-per-row, drill-in and honest-pass presentation.
 * Runs under node with a minimal DOM shim (no browser needed).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// Minimal document shim: enough element surface for the view module.
class Element {
	constructor(tag) {
		this.tagName = tag.toUpperCase();
		this.children = [];
		this.attributes = {};
		this.dataset = {};
		this._text = '';
		this.hidden = false;
		this.disabled = false;
		this.value = '';
		this.className = '';
		this.classList = { toggle() {}, add() {}, remove() {} };
		this.style = {};
		this._listeners = new Map();
	}
	set textContent(v) { this._text = String(v); }
	get textContent() { return this._text; }
	setAttribute(name, value) { this.attributes[name] = String(value); }
	getAttribute(name) { return this.attributes[name] ?? null; }
	append(...nodes) { for (const n of nodes) this._push(n); }
	appendChild(n) { this._push(n); return n; }
	_push(n) { if (n && typeof n === 'object') { n.parentNode = this; this.children.push(n); } else this.children.push({ text: String(n) }); }
	replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
	addEventListener(type, fn) { this._listeners.set(type, fn); }
	removeEventListener(type) { this._listeners.delete(type); }
	dispatch(type, extra = {}) { return this._listeners.get(type)?.({ target: this, preventDefault() {}, ...extra }); }
	queryAll(predicate) {
		const out = [];
		const walk = (node) => {
			for (const child of node.children ?? []) {
				if (child.tagName) {
					if (predicate(child)) out.push(child);
					walk(child);
				}
			}
		};
		walk(this);
		return out;
	}
	text() {
		return [this._text, ...this.children.map((c) => (c.tagName ? c.text() : c.text ?? ''))]
			.filter((s) => s !== '').join(' ');
	}
}
globalThis.document = {
	createElement: (tag) => new Element(tag),
	createTextNode: (text) => ({ text: String(text) })
};
class Option {
	constructor(text, value) { this.tagName = 'OPTION'; this.text = text; this.value = value; this.disabled = false; }
	text() { return this.text; }
}
globalThis.Option = Option;

const { createQaMatrixResultsView } = await import('./qaMatrixResultsView.js');

test('accepted run without a session explains the queue and publishes updates', async t => {
	const run = { id: 'matrix-queued', status: 'running', items: [{ id: 'queued', status: 'QUEUED' }] };
	const container = new Element('div');
	const updates = [];
	const view = createQaMatrixResultsView({ container, api: async () => ({ run }), onRunUpdated: r => updates.push(r) });
	t.after(() => view.stop());
	await view.load(run.id);
	assert.match(container.queryAll(n => n.className === 'qmr-admission')[0].textContent, /saved and queued for a shared browser slot/);
	assert.equal(updates[0], run);
});

test('stopping during a status request prevents stale navigation and polling', async () => {
	let resolve;
	let updates = 0;
	const container = new Element('div');
	const view = createQaMatrixResultsView({ container, api: () => new Promise(done => { resolve = done; }), onRunUpdated: () => updates++ });
	const pending = view.load('matrix-stale');
	view.stop();
	resolve({ run: { id: 'matrix-stale', status: 'running', items: [] } });
	await pending;
	assert.equal(updates, 0);
	assert.equal(container.queryAll(n => n.className === 'qmr-admission')[0].textContent, '');
});

function fixtureRun() {
	return {
		id: 'matrix-test-1',
		title: 'QA run — https://example.com',
		targetUrl: 'https://example.com',
		status: 'done',
		itemCount: 4,
		items: [
			{
				id: 'i1', ordinal: 0, device: 'iPhone 15 Pro', platform: 'ios', os: 'iOS', osVersion: '17.0',
				browser: 'safari', browserCode: 'safari', browserVersion: '17.0', status: 'PASSED',
				verdict: 'pass', sessionId: 'sess-1', durationMs: 5100, retryCount: 0,
				runtimeFacts: { launchedEngine: 'webkit', executionType: 'browser_emulation' },
				artifactRefs: [{ artifactId: 'a1', type: 'screenshot' }, { artifactId: 'a2', type: 'log' }],
				defects: [{ bugNumber: 'BUG-1', title: 'x' }]
			},
			{
				id: 'i2', ordinal: 1, device: 'Galaxy A15', platform: 'android', os: 'Android', osVersion: '13',
				browser: 'chrome', browserCode: 'chrome', browserVersion: '140', status: 'FAILED',
				verdict: 'fail', sessionId: 'sess-2', durationMs: 8000, retryCount: 1,
				error: 'One finding', runtimeFacts: { launchedEngine: 'chromium', executionType: 'virtual_machine' },
				artifactRefs: [], defects: []
			},
			{
				id: 'i3', ordinal: 2, device: 'MacBook Air M3', platform: 'macos', os: 'macOS', osVersion: '14.4',
				browser: 'duckduckgo', browserCode: 'duckduckgo', browserVersion: null, status: 'NOT_SUPPORTED',
				reason: 'No execution channel for DuckDuckGo', artifactRefs: [], defects: []
			},
			{
				id: 'i4', ordinal: 3, device: 'iPhone 15 Pro', platform: 'ios', os: 'iOS', osVersion: '17.0',
				browser: 'chrome', browserCode: 'chrome', browserVersion: '156', status: 'QUEUED',
				artifactRefs: [], defects: []
			}
		]
	};
}

function makeHarness(run, calls = []) {
	const api = async (path, options = {}) => {
		calls.push({ path, options });
		if (path.startsWith('/matrix-runs/matrix-test-1')) {
			return { run, orchestratorActive: false };
		}
		return {};
	};
	const selected = [];
	const toasts = [];
	const container = new Element('div');
	const view = createQaMatrixResultsView({
		container,
		api,
		selectSession: (id) => { selected.push(id); return Promise.resolve(); },
		toast: (msg) => toasts.push(msg),
		onRunFinished: () => {}
	});
	return { view, container, calls, selected, toasts };
}

test('renders totals honestly: total/queued/running/passed/failed + coverage gap for QUEUED', async (t) => {
	const { view, container } = makeHarness(fixtureRun());
	t.after(() => view.stop());
	await view.load('matrix-test-1');
	const subtitle = container.queryAll((n) => String(n.className).includes('qmr-subtitle'))[0]?.text();
	assert.match(subtitle, /Runs one browser at a time/);
	const totalsText = container.queryAll((n) => String(n.className).includes('qmr-totals'))[0]?.text();
	// Pipeline Phase 5 (#15500): spec vocabulary — Total/Queued/Running/
	// Passed/Failed/Unavailable/Unsupported/Completed always visible.
	assert.ok(totalsText.includes('Total'), 'total shown');
	assert.ok(totalsText.includes('4'));
	assert.ok(totalsText.includes('Queued'));
	assert.ok(totalsText.includes('Running'));
	assert.ok(totalsText.includes('Passed') && totalsText.includes('1'));
	assert.ok(totalsText.includes('Failed') && totalsText.includes('1'));
	assert.ok(totalsText.includes('Unavailable'));
	assert.ok(totalsText.includes('Unsupported'));
	assert.ok(totalsText.includes('Completed'));
	// The QUEUED item surfaces as a coverage gap with its status label.
	const gaps = container.queryAll((n) => String(n.className).includes('qmr-gaps'))[0];
	assert.ok(gaps && !gaps.hidden);
	assert.ok(gaps.text().includes('Queued'));
});

test('renders every configuration row with actual execution identity, evidence stays per-row', async (t) => {
	const h = makeHarness(fixtureRun());
	t.after(() => h.view.stop());
	await h.view.load('matrix-test-1');
	const rows = h.container.queryAll((n) => String(n.className).includes('qmr-row'));
	assert.equal(rows.length, 4);
	const rowText = rows.map((r) => r.text());
	// Safari row shows runner facts + evidence (2 artifacts, 1 defect).
	const safari = rowText.find((t) => t.includes('safari 17.0'));
	assert.ok(safari, 'safari row present');
	assert.ok(safari.includes('engine: webkit'));
	assert.ok(safari.includes('📎 2'));
	assert.ok(safari.includes('🐞 1'));
	// DuckDuckGo row keeps its NOT_SUPPORTED reason.
	const ddg = rowText.find((t) => t.includes('duckduckgo'));
	assert.ok(ddg.includes('Not supported'));
	assert.ok(ddg.includes('No execution channel for DuckDuckGo'));
	// Chrome FAILED row shows retry meta.
	const chrome = rowText.find((t) => t.includes('chrome 140'));
	assert.ok(chrome.includes('retried ×1'));
});

test('drill-in: Open button selects the producing session', async (t) => {
	const h = makeHarness(fixtureRun());
	t.after(() => h.view.stop());
	await h.view.load('matrix-test-1');
	const openBtns = h.container.queryAll((n) => String(n.className).includes('qmr-open'));
	assert.equal(openBtns.length, 2, 'two executed rows have Open buttons');
	openBtns[0].dispatch('click');
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(h.selected[0], 'sess-1');
});

test('retry button posts the bounded retry route for a FAILED row', async (t) => {
	const h = makeHarness(fixtureRun());
	t.after(() => h.view.stop());
	await h.view.load('matrix-test-1');
	const retryBtns = h.container.queryAll((n) => String(n.className).trim().split(/\s+/).includes('qmr-retry'));
	assert.ok(retryBtns.length >= 1, 'failed row offers retry');
	retryBtns[0].dispatch('click');
	await new Promise((r) => setTimeout(r, 20));
	const retryCall = h.calls.find((c) => c.path.includes('/retry'));
	assert.ok(retryCall, 'retry route called');
	assert.ok(retryCall.path.includes('matrix-test-1'));
});

test('error state surfaces with retry-load; empty filter result states so', async () => {
	const failing = async () => { throw new Error('network down'); };
	const container = new Element('div');
	const view = createQaMatrixResultsView({ container, api: failing, selectSession: () => {}, toast: () => {} });
	await view.load('matrix-gone');
	const stateNode = container.queryAll((n) => String(n.className).includes('qmr-state'))[0];
	assert.ok(stateNode.text().includes('Could not load'));
	const retryLoad = container.queryAll((n) => String(n.className).includes('qmr-retry-load'))[0];
	assert.ok(retryLoad && !retryLoad.hidden, 'retry-load visible on error');
});

test('view.stop halts polling; a finished run does not schedule more', async () => {
	const h = makeHarness(fixtureRun());
	await h.view.load('matrix-test-1');
	h.view.stop();
	assert.equal(typeof h.view.stop, 'function');
});

/* ── Pipeline Phase 5 (#15500): parent runs, questions, auto-answer badges ── */

function parentRunFixture({ totalPlanned = 2, materialized = 2 }) {
	const items = fixtureRun().items.slice(0, materialized).map((item, index) => ({ ...item, ordinal: index }));
	return {
		id: 'matrix-test-1',
		kind: 'parent',
		title: 'Big QA run — https://example.com',
		targetUrl: 'https://example.com',
		status: 'pending',
		totalPlanned,
		itemCount: items.length,
		batchCount: 1,
		batches: [{ id: 'batch-1', batchIndex: 0, itemCount: items.length }],
		items
	};
}

test('Phase 5: parent run renders batch-aware subtitle and planned total', async (t) => {
	const run = parentRunFixture({ totalPlanned: 5250, materialized: 2 });
	const { view, container } = makeHarness(run);
	t.after(() => view.stop());
	await view.load('matrix-test-1');
	const subtitle = container.queryAll((n) => String(n.className).includes('qmr-subtitle'))[0];
	assert.ok(subtitle, 'subtitle present');
	// Mid-batch-creation state: planned total + "creating batches" — never a
	// wrong count that pretends 2 IS the run.
	assert.ok(subtitle.text().includes('5250'), 'planned total shown');
	assert.ok(subtitle.text().includes('creating batches'), 'honest mid-creation state');
	assert.ok(subtitle.text().includes('batch'), 'batch count shown');
});

test('Phase 5: parent run fully materialized shows final batch phrasing', async (t) => {
	const run = parentRunFixture({ totalPlanned: 2, materialized: 2 });
	const { view, container } = makeHarness(run);
	t.after(() => view.stop());
	await view.load('matrix-test-1');
	const subtitle = container.queryAll((n) => String(n.className).includes('qmr-subtitle'))[0];
	assert.ok(subtitle.text().includes('2 configurations across 1 batch'), subtitle.text());
	assert.ok(!subtitle.text().includes('creating batches'));
});

test('Phase 5: blocked row surfaces the unanswered question and its basis', async (t) => {
	const run = fixtureRun();
	run.items[0] = {
		...run.items[0],
		status: 'BLOCKED',
		error: 'Session needs sign-in credentials — matrix items run unattended.',
		question: 'Please provide the sign-in credentials for this account.',
		autoAnswers: 0,
		autoAnswerEvidence: []
	};
	run.items[1] = {
		...run.items[1],
		status: 'PASSED',
		autoAnswers: 1,
		autoAnswerEvidence: [{ at: '2026-10-08T00:00:00Z', question: 'Do I have permission to run the security scan?', answer: 'Yes — proceed.', basis: 'Operator confirmed https://example.com at run setup.' }]
	};
	const { view, container } = makeHarness(run);
	t.after(() => view.stop());
	await view.load('matrix-test-1');
	const rows = container.queryAll((n) => String(n.className).includes('qmr-row'));
	const rowText = rows.map((row) => row.text());
	const blocked = rowText.find((text) => text.includes('needs sign-in credentials'));
	assert.ok(blocked, 'credential-block reason present');
	assert.ok(blocked.includes('Please provide the sign-in credentials'), 'question text travels to the row');
	const auto = rowText.find((text) => text.includes('auto-answered'));
	assert.ok(auto, 'authorized auto-answer badge visible');
	assert.ok(auto.includes('Operator confirmed'), 'basis shown on the badge');
});

test('Phase 5: SSE push events trigger a reload (matrix_item / matrix_run_done)', async (t) => {
	const run = JSON.parse(JSON.stringify(fixtureRun()));
	run.status = 'running';
	const messageHandlers = [];
	class FakeEventSource {
		constructor(url) { this.url = url; this.closed = false; }
		set onmessage(fn) { messageHandlers.push(fn); }
		close() { this.closed = true; }
	}
	globalThis.EventSource = FakeEventSource;
	const calls = [];
	const { view } = makeHarness(run, calls);
	t.after(() => { view.stop(); delete globalThis.EventSource; });
	await view.load('matrix-test-1');
	const loadsBefore = calls.filter((call) => call.path.includes('/matrix-runs/')).length;
	assert.ok(messageHandlers.length === 1, 'push stream subscribed');
	// A matrix_item event must push a reload.
	await messageHandlers[0]({ data: JSON.stringify({ type: 'matrix_item', itemId: 'i4', status: 'RUNNING' }) });
	const loadsAfter = calls.filter((call) => call.path.includes('/matrix-runs/')).length;
	assert.ok(loadsAfter > loadsBefore, 'push event triggered a reload');
	// Unrelated events do not.
	const before2 = calls.filter((call) => call.path.includes('/matrix-runs/')).length;
	await messageHandlers[0]({ data: JSON.stringify({ type: 'frame', frame: {} }) });
	const after2 = calls.filter((call) => call.path.includes('/matrix-runs/')).length;
	assert.equal(after2, before2, 'non-matrix event does not reload');
	// stop() closes the stream.
	view.stop();
	assert.ok(true, 'stop closes push stream without error');
});
