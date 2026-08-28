import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const entrySource = readFileSync(new URL('../public/entry.js', import.meta.url), 'utf8');

function entryFixture(reducedMotion) {
	const timers = [];
	const nodes = new Map();
	let document;

	function node(id) {
		const attributes = new Map();
		const classes = new Set();
		return {
			id,
			hidden: false,
			disabled: false,
			listeners: new Map(),
			style: { setProperty() {} },
			classList: {
				add(...names) { names.forEach(name => classes.add(name)); },
				remove(...names) { names.forEach(name => classes.delete(name)); },
				contains(name) { return classes.has(name); }
			},
			setAttribute(name, value) { attributes.set(name, String(value)); },
			removeAttribute(name) { attributes.delete(name); },
			hasAttribute(name) { return attributes.has(name); },
			toggleAttribute(name, enabled) {
				if (enabled) attributes.set(name, '');
				else attributes.delete(name);
			},
			addEventListener(name, listener) { this.listeners.set(name, listener); },
			focus() { document.activeElement = this; },
			closest() { return null; },
			append() {}
		};
	}

	for (const id of [
		'entry-experience', 'entry-welcome', 'entry-begin', 'entry-announcer',
		'galaxy-particles', 'workspace', 'skip-link', 'settings', 'toasts', 'composer-input'
	]) nodes.set(id, node(id));

	const entry = nodes.get('entry-experience');
	const begin = nodes.get('entry-begin');
	entry.setAttribute('aria-modal', 'true');
	entry.contains = control => ['entry-experience', 'entry-welcome', 'entry-begin'].includes(control?.id);
	nodes.get('entry-welcome').querySelectorAll = () => begin.disabled ? [] : [begin];
	document = {
		documentElement: node('html'),
		listeners: new Map(),
		getElementById: id => nodes.get(id),
		querySelector: selector => nodes.get(selector === '.app' ? 'workspace' : 'skip-link'),
		createDocumentFragment: () => node('fragment'),
		createElement: tag => node(tag),
		addEventListener(name, listener) { this.listeners.set(name, listener); }
	};
	const window = {
		innerWidth: 1200,
		matchMedia: query => ({ matches: query.includes('prefers-reduced-motion') ? reducedMotion : true }),
		requestAnimationFrame(callback) { callback(); return 1; },
		setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; }
	};
	runInNewContext(entrySource, {
		document,
		window,
		fetch() { throw new Error('The entry handoff must not make authentication or application requests.'); }
	});
	return { nodes, entry, begin, document, window, timers };
}

for (const reducedMotion of [false, true]) {
	test(`entry waits for Begin transmission and unlocks the workspace (${reducedMotion ? 'reduced' : 'animated'} motion)`, async () => {
		const fixture = entryFixture(reducedMotion);
		let handedOff = false;
		fixture.window.qaseEntryReady.then(() => { handedOff = true; });
		await Promise.resolve();

		assert.equal(fixture.entry.hidden, false, 'the first page must not auto-skip');
		assert.equal(handedOff, false, 'dashboard boot waits for the explicit handoff');
		assert.equal(fixture.nodes.get('workspace').hasAttribute('inert'), true);
		assert.equal(fixture.document.activeElement, fixture.begin);

		const click = fixture.begin.listeners.get('click');
		click();
		if (!reducedMotion) {
			assert.equal(fixture.entry.hidden, false, 'the entry remains present during its transition');
			assert.equal(fixture.entry.classList.contains('is-warping'), true);
			assert.equal(fixture.begin.disabled, true);
			click();
			assert.deepEqual(fixture.timers.map(timer => timer.delay), [140, 800], 'duplicate clicks cannot schedule another handoff');
			fixture.timers[0].callback();
			assert.equal(fixture.entry.classList.contains('is-leaving'), true);
			fixture.timers[1].callback();
		} else {
			assert.equal(fixture.timers.length, 0, 'reduced motion has no animation delay');
		}

		await fixture.window.qaseEntryReady;
		assert.equal(handedOff, true);
		assert.equal(fixture.entry.hidden, true);
		assert.equal(fixture.entry.hasAttribute('aria-modal'), false);
		assert.equal(fixture.document.documentElement.classList.contains('entry-active'), false);
		for (const id of ['workspace', 'skip-link', 'settings', 'toasts']) {
			assert.equal(fixture.nodes.get(id).hasAttribute('inert'), false, `${id} is interactive after entry`);
			assert.equal(fixture.nodes.get(id).hasAttribute('aria-hidden'), false, `${id} is exposed to assistive technology`);
		}
		assert.equal(fixture.document.activeElement, fixture.nodes.get('composer-input'));
	});
}
