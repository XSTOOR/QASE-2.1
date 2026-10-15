import assert from 'node:assert/strict';
import test from 'node:test';
import { createPageRouter, parsePageRoute, routeHash } from './pageRouter.js';

const runId = '12345678-1234-4234-8234-123456789abc';

test('page routes parse and serialize every supported product page', () => {
	const cases = [
		[{ name: 'runs' }, '#/runs'],
		[{ name: 'new-run' }, '#/runs/new'],
		[{ name: 'account' }, '#/account'],
		[{ name: 'bugs' }, '#/bugs'],
		[{ name: 'run', runId }, `#/runs/${runId}`],
		[{ name: 'results', runId }, `#/runs/${runId}/results`]
	];
	for (const [route, hash] of cases) {
		assert.equal(routeHash(route), hash);
		assert.equal(parsePageRoute(hash).name, route.name);
	}
});

test('invalid and unsafe routes resolve to the runs page', () => {
	for (const hash of ['#/unknown', '#/runs/not-a-run', '#/runs/../../account', '#/runs/new/results']) {
		assert.deepEqual(parsePageRoute(hash), { name: 'runs', canonical: '#/runs', valid: false });
	}
});

test('router navigation updates the URL and applies one route', async () => {
	const listeners = new Map();
	const applied = [];
	const windowObject = {
		location: { pathname: '/', search: '?studio=mock', hash: '#/runs' },
		history: {
			length: 2,
			state: null,
			pushState(state, _title, url) { this.state = state; windowObject.location.hash = new URL(url, 'https://qase.test').hash; },
			replaceState(state, _title, url) { this.state = state; windowObject.location.hash = new URL(url, 'https://qase.test').hash; },
			back() {}
		},
		addEventListener(type, listener) { listeners.set(type, listener); },
		removeEventListener(type) { listeners.delete(type); }
	};
	const router = createPageRouter({ windowObject, onRoute: route => applied.push(route.name) });
	await router.start({ applyCurrent: false });
	await router.navigate({ name: 'account' });
	assert.equal(windowObject.location.hash, '#/account');
	assert.deepEqual(applied, ['account']);
	assert.equal(windowObject.history.state.qasePushed, true);
	assert.equal(listeners.has('popstate'), true);
	router.stop();
	assert.equal(listeners.size, 0);
});

test('router start gives the landing page a canonical replaceable route', async () => {
	const applied = [];
	const windowObject = {
		location: { pathname: '/', search: '', hash: '' },
		history: {
			state: null,
			pushState() {},
			replaceState(state, _title, url) {
				this.state = state;
				windowObject.location.hash = new URL(url, 'https://qase.test').hash;
			},
			back() {}
		},
		addEventListener() {},
		removeEventListener() {}
	};
	const router = createPageRouter({ windowObject, onRoute: route => applied.push(route.name) });
	await router.start();
	assert.equal(windowObject.location.hash, '#/runs');
	assert.deepEqual(applied, ['runs']);
	assert.equal(windowObject.history.state.qasePushed, false);
});

