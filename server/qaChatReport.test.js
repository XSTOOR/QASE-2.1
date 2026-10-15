import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQaChatReport } from './report.js';

test('QA chat report lists real issues in severity order with a concise verdict', () => {
	const text = buildQaChatReport({ report: { verdict: 'fail', summary: 'Checked the public pages.', covered: ['Home', 'Contact'] }, findings: [
		{ severity: 'low', title: 'Footer overlaps', actual: 'The footer covers a link.' },
		{ severity: 'high', title: 'Contact submit fails', actual: 'Submit returns HTTP 500.' }
	] });
	assert.match(text, /QA report — Fail/);
	assert.match(text, /2 findings/);
	assert.ok(text.indexOf('Contact submit fails') < text.indexOf('Footer overlaps'));
	assert.match(text, /Submit returns HTTP 500/);
	assert.match(text, /Home, Contact/);
});
test('clean and blocked results do not claim the whole site passed', () => {
	assert.match(buildQaChatReport({ report: { verdict: 'pass' }, findings: [] }), /No issues found in the checks performed/);
	const blocked = buildQaChatReport({ report: { verdict: 'blocked', notCovered: ['Login requires an account'] }, findings: [] });
	assert.match(blocked, /Blocked/);
	assert.match(blocked, /No findings recorded; testing was blocked/);
	assert.match(blocked, /Login requires an account/);
	assert.doesNotMatch(blocked, /No issues found/);
});
test('large reports remain short and disclose omitted findings and coverage', () => {
	const text = buildQaChatReport({ report: { verdict: 'fail', summary: 'x'.repeat(20000), notCovered: Array(10).fill('y'.repeat(5000)) }, findings: Array.from({length:30}, (_, i) => ({title:`Issue ${i} `+'z'.repeat(1000), severity:'medium',actual:'a'.repeat(20000)})) });
	assert.ok(text.length < 3000);
	assert.match(text, /25 more findings/);
	assert.match(text, /Report/);
	assert.match(text, /Not covered/);
});
