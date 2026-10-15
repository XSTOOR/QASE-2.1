import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { preferredResultTab } from './runPresentation.js';
import { blockedRunReason } from './runPresentation.js';

test('runtime blockers take precedence over unrelated authentication coverage gaps', () => {
	assert.equal(blockedRunReason({ status: 'done', report: { verdict: 'blocked', notCovered: ['Authentication skipped without credentials.', 'Blocked: Runtime identity could not be verified.'] } }), 'Blocked: Runtime identity could not be verified.');
});

test('blocked runs open the prerequisite report, even with existing findings', () => {
	for (const findings of [[], [{ title: 'Unrelated link bug' }]]) {
		assert.equal(preferredResultTab({ status: 'done', report: { verdict: 'blocked' }, findings }), 'tab-report');
		assert.equal(preferredResultTab({ status: 'done', reportVerdict: 'blocked', findings }), 'tab-report');
	}
});
test('ordinary results retain findings and specialized review tabs', () => {
	assert.equal(preferredResultTab({ status: 'done', findings: [{}] }), 'tab-findings');
	assert.equal(preferredResultTab({ status: 'done', findings: [] }), 'tab-report');
	assert.equal(preferredResultTab({ mode: 'sqa' }, { sqaVisible: true }), 'tab-sqa');
	assert.equal(preferredResultTab({ mode: 'founder' }, { founderVisible: true }), 'tab-founder');
});
test('collapsed-sidebar grid rules never apply on the focused results page', () => {
	const css = readFileSync(new URL('./studio-workspace.css', import.meta.url), 'utf8');
	const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*grid-template-columns:[^{}]*\}/g)]
		.map(match => match[1]).filter(selector => selector.includes('html[data-qase-sidebar="collapsed"]'));
	assert.ok(selectors.length >= 4);
	for (const selector of selectors) assert.ok(selector.includes(':not([data-page="results"])'), selector);
});
