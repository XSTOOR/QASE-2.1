
// #17933 — Review Test Run button never dead-clicks silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createQaJourney, normalizeWebsite } from './qaJourney.js';

function makeDom() {
	const nodes = new Map();
	const node = id => {
		if (!nodes.has(id)) nodes.set(id, {
			value: '', dataset: {}, listeners: {}, hidden: false, disabled: false, textContent: '',
			addEventListener(type, callback) { this.listeners[type] = callback; },
			setAttribute() {}, removeAttribute() {}, setCustomValidity() {},
			focus() {}, reportValidity() { return true; },
			querySelector() { return { focus() {}, scrollTop: 0 }; },
			replaceChildren() {},
			append() {},
			querySelectorAll(selector) { return selector === '[data-journey-panel]' ? [node('panel0'), node('panel1'), node('panel2')] : []; }
		});
		return nodes.get(id);
	};
	return { node, nodes };
}

test('#17933 blocked Review click surfaces the reason via onBlocked (never silent)', () => {
	const { node } = makeDom();
	node('qa-target-url').value = 'https://example.com';
	const blockedReasons = [];
	let blocked = 'Choose at least one check to continue.';
	const journey = createQaJourney({
		document: { getElementById: node },
		changed() {},
		onBlocked: reason => { blockedReasons.push(reason); },
		getState: () => ({ config: { ready: true }, checks: 0, configurations: 1, coverageBlocked: blocked })
	});
	journey.start();
	node('journey-next').listeners.click(); // step 0 -> 1
	assert.equal(journey.step, 1);
	node('journey-next').listeners.click(); // step 1 -> 2 attempt, blocked
	assert.equal(journey.step, 1, 'must not advance while blocked');
	assert.deepEqual(blockedReasons, ['Choose at least one check to continue.'], 'onBlocked fired with the reason');
	assert.equal(node('journey-footer-hint').textContent, 'Choose at least one check to continue.');
	// Recovery: unblock → click advances to review.
	blocked = null;
	journey.sync();
	node('journey-next').listeners.click();
	assert.equal(journey.step, 2, 'after unblocking, Review Test Run advances');
});

test('#17933 invalid URL from a later step jumps back to the Website panel so the error is visible', () => {
	const { node } = makeDom();
	node('qa-target-url').value = 'not a website';
	// reportValidity returns false when invalid — simulate.
	node('qa-target-url').reportValidity = () => false;
	let focused = false;
	node('qa-target-url').focus = () => { focused = true; };
	const journey = createQaJourney({
		document: { getElementById: node },
		changed() {},
		onBlocked() {},
		getState: () => ({ config: { ready: true }, checks: 5, configurations: 1 })
	});
	journey.start();
	// Sneak to step 1 with a valid-looking value, then invalidate.
	node('qa-target-url').value = 'https://example.com';
	node('journey-next').listeners.click();
	assert.equal(journey.step, 1);
	node('qa-target-url').value = 'not a website';
	node('journey-next').listeners.click();
	assert.equal(journey.step, 0, 'returns to the Website panel where the URL error is visible');
	assert.equal(focused, true, 'URL input focused for correction');
});

test('#17933 catalog failure message is honest, not an eternal Loading state', () => {
	const { node } = makeDom();
	node('qa-target-url').value = 'https://example.com';
	const journey = createQaJourney({
		document: { getElementById: node },
		changed() {},
		onBlocked() {},
		getState: () => ({ config: { ready: true }, checks: 0, configurations: 1, coverageBlocked: 'The standard checks could not be loaded. Retry, then continue.' })
	});
	journey.start();
	node('journey-next').listeners.click();
	assert.equal(journey.step, 1);
	assert.equal(node('journey-next').disabled, true, 'button disabled while catalog failed');
	assert.match(node('journey-footer-hint').textContent, /could not be loaded/);
	assert.doesNotMatch(node('journey-footer-hint').textContent, /Loading/);
});
