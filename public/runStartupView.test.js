import test from 'node:test';
import assert from 'node:assert/strict';
import { startupPresentation, createRunStartupView } from './runStartupView.js';

test('queue explains capacity waiting and never asks the user to select a browser', () => {
	const view = startupPresentation({ status: 'running', items: [{ status: 'QUEUED', browser: 'Chromium', device: 'Desktop' }] }, { position: 2 });
	assert.match(view.detail, /position 2/);
	assert.match(view.detail, /automatically/);
	assert.equal(view.terminal, false);
});
test('startup failures and cancellations are honest terminal outcomes', () => {
	assert.match(startupPresentation({ status: 'error', items: [{ error: 'Browser failed' }] }).detail, /Browser failed/);
	assert.equal(startupPresentation({ status: 'cancelled' }).title, 'Test cancelled');
	assert.equal(startupPresentation({ status: 'running', items: [] }, null).terminal, false);
});
class Node {
	constructor() { this.children = []; this.dataset = {}; this.hidden = false; this.textContent = ''; }
	append(...nodes) { this.children.push(...nodes); }
	replaceChildren(...nodes) { this.children = nodes; }
	setAttribute() {}
}
test('leaving during a pending startup response cannot navigate or resurrect the page', async () => {
	globalThis.document = { createElement: () => new Node() };
	let finish, opened = 0;
	const container = new Node();
	const view = createRunStartupView({ container, api: () => new Promise(resolve => { finish = resolve; }), openSession: () => opened++ });
	const loading = view.load('matrix-stale'); view.stop();
	finish({ run: { items: [{ sessionId: 'ready', status: 'RUNNING' }] } });
	await loading;
	assert.equal(opened, 0); assert.equal(container.hidden, true);
	delete globalThis.document;
});
