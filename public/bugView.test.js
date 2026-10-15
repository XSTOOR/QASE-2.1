import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bugMatches } from '../public/bugView.js';

const base = {
	bugNumber: 'BUG-0001',
	title: 'Login fails on iOS 18',
	category: 'auth',
	status: 'open',
	severity: 'high',
	environmentSnapshot: { device: 'iPhone 16 Pro', os: 'iOS', osVersion: '18.3' }
};

test('bugMatches passes with empty filters', () => {
	assert.equal(bugMatches(base, { search: '', status: '', severity: '' }), true);
});

test('bugMatches filters by status, severity and their combination', () => {
	const filters = { search: '', status: '', severity: '' };
	assert.equal(bugMatches(base, { ...filters, status: 'open' }), true);
	assert.equal(bugMatches(base, { ...filters, status: 'resolved' }), false);
	assert.equal(bugMatches(base, { ...filters, severity: 'high' }), true);
	assert.equal(bugMatches(base, { ...filters, severity: 'critical' }), false);
	assert.equal(bugMatches(base, { ...filters, status: 'open', severity: 'high' }), true);
	assert.equal(bugMatches(base, { ...filters, status: 'resolved', severity: 'high' }), false);
});

test('bugMatches search hits bug number, title, category and device', () => {
	const filters = { status: '', severity: '' };
	assert.equal(bugMatches(base, { ...filters, search: 'bug-0001' }), true);
	assert.equal(bugMatches(base, { ...filters, search: 'LOGIN' }), true);
	assert.equal(bugMatches(base, { ...filters, search: 'auth' }), true);
	assert.equal(bugMatches(base, { ...filters, search: 'galaxy' }), false);
	assert.equal(bugMatches(base, { ...filters, search: 'iphone 16' }), true);
});

test('bugMatches search combines with severity filter', () => {
	assert.equal(bugMatches(base, { search: 'login', status: '', severity: 'critical' }), false);
	assert.equal(bugMatches(base, { search: 'login', status: 'open', severity: 'high' }), true);
});

test('bugMatches tolerates missing optional fields', () => {
	const bare = { bugNumber: 'BUG-0002', title: 'Crash', status: 'open', severity: 'low' };
	assert.equal(bugMatches(bare, { search: 'crash', status: '', severity: '' }), true);
	assert.equal(bugMatches(bare, { search: 'iphone', status: '', severity: '' }), false);
});
