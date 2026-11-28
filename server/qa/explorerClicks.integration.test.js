import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import http from 'node:http';
import { createQaBrowser, VIEWPORTS } from './browser.js';
import { explore } from './explorer.js';
import { createQaModels, qaModelSettings } from './models.js';
import { createRouter } from './router.js';

test('JEV chooses which proposed click reaches the browser', async t => {
	const chromiumBrowser = await chromium.launch();
	t.after(() => chromiumBrowser.close());
	for (const choice of ['step1', 'unknown']) {
		await t.test(choice, async () => {
			const page = await chromiumBrowser.newPage();
			const received = [];
			const startUrl = 'http://qa.test/';
			await page.exposeFunction('recordClick', label => received.push(label));
			await page.route(startUrl, route => route.fulfill({ contentType: 'text/html', body:
				'<button onclick="recordClick(this.textContent)">Home</button><button onclick="recordClick(this.textContent)">Help</button>'
			}));
			const browser = {
				openPage: async () => ({ page, log: {} }),
				setActivePage() {},
				goto: (target, url) => target.goto(url),
				interact: action => action(),
				settle: async () => {}
			};
			let payload;
			const model = createQaModels({
				settings: qaModelSettings({ QASE_API_KEY: 'fixture-key' }, {}),
				fetchImpl: async (_url, request) => {
					payload = JSON.parse(request.body);
					return Response.json({ model: 'jev-1.13', answers: { next: { type: 'choice', choice } } });
				}
			});
			const router = createRouter({ models: model });
			const models = { ...router.models, visionAvailable: () => false, async chat(messages) {
				const toolCalls = ['Home', 'Help'].map(label => {
					const ref = new RegExp('(e[0-9]+) button "' + label + '"').exec(messages[1].content)[1];
					return { id: label, function: { name: 'click', arguments: JSON.stringify({ ref, expect: 'Open ' + label }) } };
				});
				return { toolCalls };
			} };
			const { summary } = await explore({ browser, profile: VIEWPORTS.desktop, startUrl, models,
				goal: 'Open Help for fixture-private-marker', blockedWrites: () => 0, maxSteps: 1, deadline: Date.now() + 30000 });
			assert.match(payload.questions.next.criteria.step1, /help/);
			assert.doesNotMatch(JSON.stringify(payload), /fixture-private-marker|qa\.test/);
			if (choice === 'step1') {
				assert.deepEqual(received, ['Help']);
				assert.match(summary.trail[0], /selected by JEV/);
				assert.equal(router.state().decisions.at(-1).task, 'action');
			} else {
				assert.deepEqual(received, []);
				assert.match(summary.actionGap, /valid action decision/);
			}
		});
	}
});

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
		jevAvailable: () => true, decide: async () => ({next:{type:'choice',choice:'step0'}}),
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
			const models = {
		jevAvailable: () => true, decide: async () => ({next:{type:'choice',choice:'step0'}}), reasonerAvailable: () => true, visionAvailable: () => false, async chat(messages) {
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
