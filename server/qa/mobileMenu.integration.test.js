import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { checkMobileMenu } from './detectors/mobileMenu.js';
import { testForms } from './detectors/forms.js';

test('real mobile menu interactions', async t => {
	const browser = await chromium.launch();
	t.after(() => browser.close());
	for (const [variant, expected] of [
		['working', 'passed'], ['inert', 'failed'], ['stuck open', 'failed'], ['unrelated changes', 'failed'],
		['covered links', 'failed'], ['separate close', 'passed'], ['missing', 'not_applicable'], ['ambiguous', 'inconclusive'], ['restricted', 'inconclusive'],
		['background writes', 'passed'], ['blocked navigation', 'inconclusive'], ['two panels', 'passed'], ['second panel stays open', 'failed']
	]) await t.test(variant, async () => {
		const page = await browser.newPage({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
		try {
			await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><header><button id="toggle" aria-controls="nav">Menu</button><nav id="nav" hidden><a href="/a">About</a> <a href="/b">Pricing</a></nav></header><p id="news"></p>');
			await page.evaluate(kind => {
				const [button, nav, news] = ['toggle', 'nav', 'news'].map(id => document.getElementById(id));
				if (kind === 'missing') return button.remove();
				if (kind === 'ambiguous') { button.removeAttribute('aria-controls'); document.body.append(nav); }
				if (kind === 'two panels' || kind === 'second panel stays open') {
					const secondary = document.createElement('nav');
					secondary.id = 'secondary';
					secondary.hidden = true;
					secondary.append(nav.lastElementChild);
					nav.after(secondary);
					button.setAttribute('aria-controls', 'nav   secondary');
					button.textContent = 'Browse';
				}
				button.onclick = () => {
					if (kind === 'inert' || kind === 'restricted') return;
					if (kind === 'unrelated changes') { news.innerHTML = '<a href="/promo">Promotion</a>'; return; }
					nav.hidden = kind === 'stuck open' ? false : !nav.hidden;
					const secondary = document.getElementById('secondary');
					if (secondary) secondary.hidden = kind === 'second panel stays open' ? false : nav.hidden;
					if (kind === 'covered links') {
						const cover = document.createElement('div');
						cover.style.cssText = 'position:fixed;inset:0;background:white';
						document.body.append(cover);
					}
					if (kind === 'separate close') {
						button.hidden = true;
						const close = document.createElement('button');
						close.textContent = 'Close menu';
						close.onclick = () => { nav.hidden = true; close.remove(); button.hidden = false; };
						nav.append(close);
					}
				};
			}, variant);
			const captures = [];
			let blocked = 0;
			const result = await checkMobileMenu(page, {
				browser: { interact: work => work(), blocked: () => ({ write_blocked: blocked, navigation: variant === 'blocked navigation' ? blocked : 0 }), activate: (handle, opts) => {
					if (['restricted', 'background writes', 'blocked navigation'].includes(variant)) blocked++;
					return handle.tap(opts);
				} },
				save: async (bytes, label) => { assert.ok(bytes.length > 100); captures.push(label); return String(captures.length); }
			});
			assert.equal(result.status, expected, result.detail);
			if (expected === 'passed') {
				assert.deepEqual(result.evidence.map(item => item.label), ['Before opening', 'After opening', 'After closing']);
				assert.match(result.detail, /0 → 2 → 0/);
			}
		} finally { await page.close(); }
	});
});

test('a local sample form focuses the empty required field and blocks submission', async t => {
	const browser = await chromium.launch();
	t.after(() => browser.close());
	const page = await browser.newPage();
	let submits = 0;
	await page.exposeFunction('observedSubmit', () => submits++);
	const html = '<form onsubmit="event.preventDefault(); observedSubmit()"><label>Name<input name="name" required></label><button>Save</button></form>';
	const reload = () => page.setContent(html);
	await reload();
	const options = { url: 'https://fixture.test/', viewport: 'mobile', browser: { interact: work => work() }, blocked: () => 0, reload, save: async () => undefined };
	const result = await testForms(page, options);
	assert.equal(submits, 0);
	assert.equal(result.requiredChecks[0].status, 'passed', result.requiredChecks[0].detail);
	assert.match(result.requiredChecks[0].detail, /Please fill out this field/);
	await page.evaluate(() => document.querySelector('button').onclick = e => e.preventDefault());
	const inert = await testForms(page, options);
	assert.equal(inert.requiredChecks[0].status, 'inconclusive');
});
