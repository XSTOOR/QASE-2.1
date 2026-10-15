import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildReportMarkdown } from './report.js';

async function freshStore() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qase-scope-'));
	process.chdir(directory);
	return import(`./store.js?scope=${Date.now()}-${Math.random()}`);
}

const originalDirectory = process.cwd();

test('store persists a whitelisted scopeSelection on run creation', async t => {
	const store = await freshStore();
	t.after(() => { store.flushSessions(); process.chdir(originalDirectory); });
	const session = store.createSession('Scoped run', { scopeSelection: ['desktop-layout', 'ui-consistency', 'junk'] });
	assert.deepEqual(session.scopeSelection, ['desktop-layout', 'ui-consistency']);
	const legacy = store.createSession('Legacy run', {});
	assert.equal(legacy.scopeSelection, undefined);
});

test('store rejects a non-array scopeSelection', async t => {
	const store = await freshStore();
	t.after(() => { store.flushSessions(); process.chdir(originalDirectory); });
	assert.throws(() => store.createSession('Bad', { scopeSelection: 'forms' }), /invalid scope selection/);
	assert.throws(() => store.createSession('Bad', { scopeSelection: 42 }), /invalid scope selection/);
});

test('markdown report renders the selected coverage block', () => {
	const session = {
		targetUrl: 'https://example.com/',
		createdAt: Date.now(),
		findings: [],
		todos: [],
		scopeSelection: ['desktop-layout', 'ui-consistency'],
		report: { verdict: 'pass', summary: 'Fine.', covered: ['Homepage'], notCovered: [], recommendations: [] }
	};
	const markdown = buildReportMarkdown(session);
	assert.match(markdown, /## What was tested — selected coverage/);
	assert.match(markdown, /\*\*UI & User Experience\*\*/);
	assert.match(markdown, /- ✓ Desktop layout & responsive behaviour/);
	assert.match(markdown, /- ✓ UI consistency/);
	assert.match(markdown, /- ✗ Mobile layout/);
	assert.doesNotMatch(markdown, /Other supported coverage/);
});

test('markdown report omits the block for legacy runs without scopeSelection', () => {
	const session = {
		targetUrl: 'https://example.com/',
		createdAt: Date.now(),
		findings: [],
		todos: [],
		report: { verdict: 'pass', summary: 'Fine.', covered: ['Homepage'], notCovered: [], recommendations: [] }
	};
	assert.doesNotMatch(buildReportMarkdown(session), /What was tested/);
});
