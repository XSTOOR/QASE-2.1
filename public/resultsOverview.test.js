import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resultsOverviewModel } from './resultsOverview.js';

test('blocked overview keeps real findings and an explicit next step', () => {
	const model = resultsOverviewModel({ status: 'done', report: { verdict: 'blocked', summary: 'Credentials required', recommendations: ['Provide a test account'], notCovered: ['Login'] }, findings: [{ severity: 'high' }, { severity: 'low' }] });
	assert.equal(model.status, 'blocked'); assert.equal(model.tone, 'blocked');
	assert.equal(model.total, 2); assert.equal(model.severity.high, 1); assert.equal(model.severity.low, 1);
	assert.deepEqual(model.next, ['Provide a test account']); assert.equal(model.gaps.length, 1);
});
test('severity derives from actual findings when aggregate counts were not saved', () => {
	assert.equal(resultsOverviewModel({ findings: [{ severity: 'MEDIUM' }] }).severity.medium, 1);
	assert.equal(resultsOverviewModel({ report: { bySeverity: { medium: 3 } }, findings: [] }).severity.medium, 3);
});
test('unknown and failed reports are never presented as a passing test', () => {
	assert.equal(resultsOverviewModel({ report: {} }).tone, 'neutral');
	assert.equal(resultsOverviewModel({ report: { verdict: 'fail' } }).tone, 'attention');
	assert.equal(resultsOverviewModel({ report: { verdict: 'pass' } }).tone, 'passed');
});
test('partial coverage has a distinct completed outcome without claiming a pass', () => {
	const model = resultsOverviewModel({ status: 'done', report: { verdict: 'partial', notCovered: ['Forms were not submitted.'] } });
	assert.equal(model.status, 'partial');
	assert.equal(model.tone, 'neutral');
	assert.equal(model.title, 'Testing completed with coverage gaps');
	assert.equal(model.gaps.length, 1);
});
test('report data renders as text and focused layouts retain workspace access', () => {
	const source = readFileSync(new URL('./resultsOverview.js', import.meta.url), 'utf8');
	const css = readFileSync(new URL('./resultsPage.css', import.meta.url), 'utf8');
	assert.doesNotMatch(source, /innerHTML/); assert.match(source, /addEventListener\('click', onWorkspace\)/);
	assert.match(css, /\.viewer > :is\(\.panel-head,\.stage\) \{ display: none !important/);
	assert.match(css, /@media \(max-width: 760px\)/);
});

test('results review never automatically opens a rating prompt, including deep links', () => {
	const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
	const sync = app.slice(app.indexOf('async function syncFeedbackForSession'), app.indexOf('async function openFeedbackModal'));
	assert.doesNotMatch(sync, /openFeedbackModal\(\)/);
	assert.match(app, /provideFeedback\.onclick = \(\) => openFeedbackModal\(\)/);
});
