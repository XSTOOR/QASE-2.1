import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright';
import { createFounderFormTool, runFounderFormReview } from './founderFormReview.js';

const selectors = { fieldLabel: 'Task name', submitName: 'Save local task' };

test('the Founder form tool accepts only two exact observed names', async () => {
	const calls = [];
	const tool = createFounderFormTool((input, signal) => { calls.push([input, signal]); return { success: true }; });
	assert.equal((await tool.run({ field_label: 'Task name', submit_name: 'Save local task', value: 'arbitrary' })).success, false);
	assert.equal(calls.length, 0);
	const { signal } = new AbortController();
	assert.equal((await tool.run({ field_label: 'Task name', submit_name: 'Save local task' }, { signal })).success, true);
	assert.deepEqual(calls, [[selectors, signal]]);
});

test('the isolated Founder form captures native rejection and local acceptance, and blocks network writes', async () => {
	const requests = [];
	const fixture = createServer((req, res) => {
		requests.push([req.method, req.url]);
		res.setHeader('Content-Type', 'text/html');
		const send = req.url === '/network' ? "fetch('/write', { method: 'POST', body: 'sample' }).catch(() => {});" : '';
		res.end(`<!doctype html><link rel="icon" href="data:,"><form><label>Task name<input required minlength="2"></label><button>Save local task</button><output></output></form>
			<script>document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); ${send} document.querySelector('output').textContent = 'Local task saved'; });</script>`);
	});
	await new Promise((resolve, reject) => fixture.once('error', reject).listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${fixture.address().port}`;
	let browser;
	try {
		browser = await chromium.launch();
		const run = async (route, extra = {}) => {
			const saved = [];
			const result = await runFounderFormReview({
				...selectors, browser, url: origin + route,
				permitRead: async target => new URL(target).origin === origin,
				saveCase: async item => { saved.push(item); return `saved-${saved.length}`; },
				...extra
			});
			assert.equal(browser.contexts().length, 0);
			return { result, saved };
		};
		const { result, saved } = await run('/local');
		assert.equal(result.success, true, result.error);
		assert.equal(saved.length, 2);
		assert.deepEqual(result.cases.map(item => item.activity_id), ['saved-1', 'saved-2']);
		assert.equal(saved[0].validity.valid, false);
		assert.ok(saved[0].validity.failures.includes('tooShort'));
		assert.deepEqual(saved[0].feedback, []);
		assert.equal(saved[1].validity.valid, true);
		assert.equal(saved[1].feedback[0]?.text, 'Local task saved');
		const remote = await run('/network');
		assert.equal(remote.result.success, false);
		assert.match(remote.result.error, /attempted network access/);
		assert.equal(remote.saved.at(-1)?.networkBlocked, true);
		assert.deepEqual(requests, [['GET', '/local'], ['GET', '/network']]);
	} finally {
		await browser?.close();
		fixture.closeAllConnections();
		await new Promise(resolve => fixture.close(resolve));
	}
});
