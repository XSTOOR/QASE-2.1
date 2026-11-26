import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import http from 'node:http';
import { createQaBrowser, VIEWPORTS } from './browser.js';
import { explore } from './explorer.js';

// Drive the real explorer with a fixed intent. The page's event listener is an
// independent witness of which control actually received the browser click.
for (const variant of ['working', 'copied', 'replaced', 'covered', 'wrong destination', 'unrelated page change']) {
	test(`Solutions click: ${variant}`, async t => {
		const chromiumBrowser = await chromium.launch();
		t.after(() => chromiumBrowser.close());
		const page = await chromiumBrowser.newPage();
		const clicks = [];
		await page.exposeFunction('witnessClick', id => clicks.push(id));
		await page.route('http://qa.test/**', route => {
			const heading = new URL(route.request().url()).pathname === '/pricing' ? 'Pricing' : 'Solutions';
			return route.fulfill({ contentType: 'text/html', body: route.request().url().endsWith('/')
				? '<nav><button id="top">Solutions</button></nav><footer><button id="bottom">Solutions</button></footer>'
				: `<h1>${heading}</h1>` });
		});
		const exercised = new Set();
		const browser = {
			openPage: async () => ({ page, log: {} }), setActivePage() {},
			goto: async (p, url) => {
				await p.goto(url);
				await p.evaluate(kind => {
					if (kind === 'unrelated page change') document.querySelector('nav').innerHTML = '<a id="top" href="/solutions">Solutions</a>';
					document.addEventListener('click', async event => {
						event.preventDefault();
						await window.witnessClick(event.target.id);
						if (kind === 'unrelated page change') {
							document.body.insertAdjacentHTML('beforeend', '<h2>New promotion</h2>');
							return;
						}
						location.href = event.target.id === 'top' && kind !== 'wrong destination' ? '/solutions' : '/pricing';
					});
				}, variant);
			},
			interact: action => action(),
			settle: async () => { if (clicks.length && variant !== 'unrelated page change') await page.waitForURL(url => url.pathname !== '/'); }
		};
		let step = 0;
		const models = {
			reasonerAvailable: () => true, visionAvailable: () => false,
			async chat(messages) {
				const evidence = messages.at(-1).content;
				if (step === 1 && variant === 'wrong destination' && evidence.includes('RESULT: URL changed to http://qa.test/pricing')) {
					step++;
					return { text: '', toolCalls: [{ id: 'issue', function: { name: 'report_issue', arguments: JSON.stringify({
						title: 'Solutions opens Pricing', category: 'navigation', severity: 'medium',
						expected: 'Open the Solutions page', actual: 'The Pricing page opened', evidence: 'The URL changed to /pricing'
					}) } }] };
				}
				if (step++) return { text: '', toolCalls: [{ id: 'end', function: { name: 'finish', arguments: '{}' } }] };
				const ref = /\b(e\d+) (?:button|a) "Solutions"/.exec(messages[1].content)[1];
				await page.evaluate(kind => {
					const original = document.querySelector('#top');
					if (kind === 'copied' || kind === 'replaced') {
						const copy = original.cloneNode(true);
						copy.id = 'promo';
						original.before(copy);
						if (kind === 'replaced') original.remove();
					}
					if (kind === 'covered') {
						const cover = document.createElement('div');
						cover.style.cssText = 'position:fixed;inset:0;background:white';
						document.body.append(cover);
					}
				}, variant);
				return { text: '', toolCalls: [{ id: 'click', function: { name: 'click', arguments: JSON.stringify({ ref, expect: 'Open the Solutions page' }) } }] };
			}
		};
		const result = await explore({ browser, profile: { label: 'Desktop' }, startUrl: 'http://qa.test/', models, exercised,
			blockedWrites: () => 0, save: async () => 'fixture-screenshot', deadline: Date.now() + 30000, maxSteps: 3 });
		const action = result.summary.trail[0];
		if (variant === 'covered' || variant === 'replaced') {
			assert.deepEqual(clicks, []);
			assert.equal(exercised.size, 0);
			assert.match(action, /failed|no longer exists/i);
		} else if (variant === 'unrelated page change') {
			assert.deepEqual(clicks, ['top']);
			assert.equal(exercised.size, 0);
			assert.match(action, /Link destination unverified/);
		} else {
			assert.deepEqual(clicks, ['top']);
			assert.deepEqual([...exercised], ['Solutions']);
			assert.match(action, /click recipient: button e\d+/);
			assert.match(action, /expecting Open the Solutions page/);
			assert.match(action, variant === 'wrong destination' ? /URL changed to http:\/\/qa.test\/pricing/ : /URL changed to http:\/\/qa.test\/solutions/);
		}
		assert.deepEqual(result.candidates.map(issue => issue.title), variant === 'wrong destination' ? ['Solutions opens Pricing'] : []);
	});
}

test('navigation evidence from the browser runtime', async t => {
	const server = http.createServer((request, response) => {
		response.setHeader('Content-Type', 'text/html');
		const variant = request.url.slice(1);
		const link = (attributes, href = '/solutions') => `<a href="${href}" ${attributes}>Solutions</a>`;
		const menu = '<ul id="menu" hidden><li><a href="/one">Business plans</a></li></ul>';
		const openMenu = 'onclick="event.preventDefault(); document.querySelector(\'#menu\').hidden=false"';
		const fixtures = {
			menu: link(`aria-controls="menu" ${openMenu}`) + menu,
			unrelated: link(openMenu) + menu,
			tab: link('target="_blank"'),
			blank: link('onclick="event.preventDefault(); window.open(\'about:blank\')"'),
			blocked: link('', 'https://outside.invalid/solutions')
		};
		response.end(fixtures[variant] ?? '<h1>Solutions</h1>');
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
	const base = `http://127.0.0.1:${server.address().port}`;
	const browser = await createQaBrowser({ session: { targetUrl: base, engine: 'chromium' },
		env: { ...process.env, NODE_ENV: 'test', QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: '127.0.0.1' } });
	t.after(() => browser.close());
	for (const [variant, expected] of Object.entries({
		menu: /Submenu opened for "Solutions": Business plans/, unrelated: /Link destination unverified/,
		tab: /Link opened the expected new tab/, blank: /new tab opened.*not verified/,
		blocked: /Navigation blocked by this run's site scope/
	})) {
		await t.test(variant, async () => {
			const exercised = new Set();
			const models = { reasonerAvailable: () => true, visionAvailable: () => false, async chat(messages) {
				const ref = /\b(e\d+) a "Solutions"/.exec(messages[1].content)[1];
				return { toolCalls: [{ id: 'open', function: { name: 'click', arguments: JSON.stringify({ ref, expect: 'Open Solutions' }) } }] };
			} };
			const { summary } = await explore({ browser, profile: VIEWPORTS.desktop, startUrl: base + '/' + variant,
				models, exercised, blockedWrites: () => browser.blocked().write_blocked, maxSteps: 1, deadline: Date.now() + 30000 });
			assert.match(summary.trail[0], expected);
			assert.deepEqual([...exercised], variant === 'tab' ? ['Solutions'] : []);
			assert.deepEqual(summary.visited, [base + '/' + variant]);
		});
	}
});
