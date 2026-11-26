import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { reviewFirstPages } from './pageReview.js';

// Each checkpoint is serialized independently, like a client refresh or a new worker.
test('page checkpoints, dashboard refresh and recovery', async t => {
	const browser = await chromium.launch();
	t.after(() => browser.close());
	const home = 'https://fixture.test/';
	let clicks = 0;
	let wrong = false;
	let status = 200;
	const reopen = async () => {
		const page = await browser.newPage();
		await page.route('https://fixture.test/**', route => {
			const isHome = route.request().url() === home;
			const html = isHome ? '<title>Home</title><nav><a href="/solutions/" id="target">Solutions</a></nav>' : '<title>Solutions</title>';
			return route.fulfill({ status: isHome ? 200 : status, contentType: 'text/html', body: html });
		});
		await page.goto(home);
		if (wrong) await page.evaluate(() => document.querySelector('a').onclick = e => { e.preventDefault(); location.href = '/pricing/'; });
		return page;
	};
	const snapshots = [];
	const options = {
		state: {}, observation: { url: home, title: 'Home', status: 200, screenshot: 'home-1' }, reopen,
		browser: { inScope: url => new URL(url).origin === new URL(home).origin, activate: async (handle, opts) => { clicks++; await handle.click(opts); }, interact: work => work(), settle: async () => {} },
		save: async bytes => { assert.ok(bytes.length); return 'solutions-1'; }, stopped: () => false, allowNext: true,
		checkpoint: async () => snapshots.push(JSON.stringify(options.state))
	};
	await reviewFirstPages(options);
	const [first, pending, last] = snapshots.map(JSON.parse);
	assert.equal(first.pageReview.pages.length, 1);
	assert.equal(first.pageReview.journey, undefined);
	assert.equal(pending.pageReview.journey.status, 'running');
	assert.deepEqual(last.pageReview.pages.map(p => p.path), ['/', '/solutions/']);
	assert.deepEqual(last.pageReview.pages[1].checks.map(c => c.status), ['passed','passed']);
	assert.equal(last.pageReview.journey.actual, '/solutions/');
	assert.equal(clicks, 1);

	// Load the production Plan and Results renderers in a separate browser tab.
	const tab = await browser.newPage();
	let visible = first;
	await tab.route('https://dashboard.test/**', async route => {
		const path = new URL(route.request().url()).pathname.slice(1);
		if (path === 'session') return route.fulfill({ json: { mode: 'qa', id: 'test', status: 'running', targetUrl: home, hybrid: { version: 2, ...visible } } });
		if (/^[a-zA-Z]+\.js$/.test(path)) return route.fulfill({ contentType: 'application/javascript', body: await readFile(new URL('../../public/' + path, import.meta.url)) });
		return route.fulfill({ contentType: 'text/html', body: '<main id="plan"></main><main id="report"></main><script type="module">import {createQaEvidenceWorkspace} from "./qaEvidenceView.js"; const workspace = createQaEvidenceWorkspace({plan, report, api: async()=>({})}); window.refresh=async()=>workspace.update(await (await fetch("/session")).json()); await refresh();</script>' });
	});
	await tab.goto('https://dashboard.test/');
	for (const action of [() => tab.locator('#plan h4').first().waitFor(), () => tab.reload()]) {
		await action();
		await tab.locator('#report h4').first().waitFor();
		assert.deepEqual(await tab.locator('#report .qe-details h4').allTextContents(), ['/']);
	}
	visible = last;
	await tab.evaluate(() => window.refresh());
	assert.deepEqual(await tab.locator('#plan .qe-details h4').allTextContents(), ['/', '/solutions/']);
	assert.equal(await tab.getByText(/Observed \/solutions\//).count(), 2);
	visible = structuredClone(last);
	visible.pageReview.mobileMenu = { status: 'failed', control: 'Menu', viewport: 'Mobile 390×844',
		expected: 'Links appear', detail: 'No tappable links appeared.', evidence: [{ label: 'After opening', artifactId: 'menu-open' }] };
	visible.pageReview.formValidation = [{ path: '/contact', form: 1, status: 'passed', field: 'Name', detail: 'The form blocked the action and showed “Enter your name.”', artifactId: 'inline-error' }];
	await tab.evaluate(() => window.refresh());
	await tab.reload();
	await tab.locator('#report').getByText('Mobile navigation menu · failed').waitFor();
	for (const selector of ['#plan', '#report']) {
		const panel = tab.locator(selector);
		assert.equal(await panel.getByText('Observed · No tappable links appeared.').count(), 1);
		assert.equal(await panel.getByRole('link', { name: 'After opening' }).getAttribute('href'), '/api/sessions/test/artifacts/menu-open');
		const validation = selector === '#report' ? 'Required-field check: passed' : 'passed';
		assert.equal(await panel.getByText('/contact · Form 1 · ' + validation + ' · Name', { exact: false }).count(), 1);
		assert.equal(await panel.getByRole('link', { name: 'View validation screenshot' }).getAttribute('href'), '/api/sessions/test/artifacts/inline-error');
		assert.equal(await panel.getByText(/Name · The form blocked the action and showed “Enter your name.”/).count(), 1);
	}

	// Different required fields commonly produce identical native validation messages.
	const validation = 'Please fill out this field.';
	visible.formOutcomes = [{ path: '/notes', form: 1, field: 'Note title', validation }];
	visible.pageReview.formValidation = ['Note title', 'Description'].map(field => ({
		path: '/notes', form: 1, field, status: 'passed', detail: validation, artifactId: field === 'Note title' ? 'title-error' : 'description-error'
	}));
	await tab.reload();
	const outcome = tab.locator('#report section.qe-details').filter({ hasText: 'Validation observed · submission unverified' });
	await outcome.getByText('Empty required field (Note title): “' + validation + '”').waitFor();
	assert.equal(await outcome.getByRole('link', { name: 'View validation screenshot' }).getAttribute('href'), '/api/sessions/test/artifacts/title-error');
	const otherField = tab.locator('#report p').filter({ hasText: 'Required-field check: passed · Description' });
	assert.equal(await otherField.getByRole('link').getAttribute('href'), '/api/sessions/test/artifacts/description-error');

	for (const [snapshot, expected] of [[last, 'passed'], [pending, 'inconclusive']]) {
		const restored = structuredClone(snapshot);
		await reviewFirstPages({ ...options, state: restored, reopen: () => assert.fail('should not replay a click') });
		assert.equal(restored.pageReview.journey.status, expected);
		assert.deepEqual(restored.pageReview.pages, snapshot.pageReview.pages);
	}
	assert.equal(clicks, 1);
	options.state = structuredClone(first);
	status = 404;
	await reviewFirstPages(options);
	assert.equal(options.state.pageReview.pages.length, 2);
	assert.equal(options.state.pageReview.pages[1].checks[0].status, 'failed');
	assert.equal(options.state.pageReview.journey.status, 'passed');
	options.state = {};
	wrong = true;
	await reviewFirstPages(options);
	assert.equal(options.state.pageReview.journey.status, 'failed');
	assert.equal(options.state.pageReview.journey.actual, '/pricing/');
	assert.equal(options.state.pageReview.pages.length, 1);
	const before = clicks;
	await assert.rejects(reviewFirstPages({ ...options, state: {}, checkpoint: async () => { throw Error('disk full'); } }), /disk full/);
	assert.equal(clicks, before);
});

test('hash navigation reports a rendered SPA view and ignores document anchors', async t => {
	const runtime = await chromium.launch();
	t.after(() => runtime.close());
	const home = 'https://fixture.test/app';
	for (const [name, href, expected] of [
		['rendered', '#/solutions', 'passed'], ['hashbang', '#!/solutions', 'passed'],
		['URL only', '#/solutions', 'inconclusive'], ['wrong route', '#/solutions', 'failed'],
		['section anchor', '#overview', 'untested'], ['excluded route', '#/logout', 'untested']
	]) await t.test(name, async () => {
		const page = await runtime.newPage();
		await page.route('https://fixture.test/**', route => route.fulfill({ contentType: 'text/html',
			body: '<title>App</title><nav><a href="#overview">Overview</a><a href="' + href + '">Solutions</a></nav><main><h1>Home</h1></main>' }));
		await page.goto(home + '#/home');
		await page.evaluate(mode => {
			if (mode === 'wrong route') document.querySelectorAll('a')[1].onclick = e => { e.preventDefault(); location.hash = '/pricing'; };
			onhashchange = () => { if (mode !== 'URL only') document.querySelector('h1').textContent = location.hash; };
		}, name);
		let clicks = 0;
		const state = {};
		await reviewFirstPages({ state, observation: { url: page.url(), title: 'App', status: 200 }, entryPage: page, stopped: () => false, allowNext: true,
			browser: { inScope: () => true, interact: fn => fn(), activate: (handle, opts) => { clicks++; return handle.click(opts); }, settle: async () => {} },
			save: async () => 'route-image', checkpoint: async () => {} });
		const { pages, journey } = state.pageReview;
		assert.equal(journey.status, expected, journey.detail);
		assert.equal(pages[0].path, '/app#/home');
		assert.equal(clicks, expected === 'untested' ? 0 : 1);
		if (expected === 'passed') {
			assert.equal(journey.expected, '/app' + href);
			assert.equal(journey.actual, journey.expected);
			assert.equal(pages[1].path, journey.expected);
			assert.equal(pages[1].checks[0].status, 'not applicable');
			assert.equal(pages[1].screenshot, 'route-image');
		} else assert.equal(pages.length, 1);
		if (name === 'wrong route') assert.equal(journey.actual, '/app#/pricing');
	});
});
