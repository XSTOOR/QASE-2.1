import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { formOutcomeObserver } from './formOutcome.js';
import { startStagingForm } from '../../scripts/fixtures/staging-form.mjs';
import { startFieldNotes } from '../../scripts/fixtures/field-notes.mjs';

async function clickObserved(observer, button) {
	const control = await button.elementHandle();
	try { await observer.observe(control, () => control.click()); }
	finally { await control.dispose(); }
}

test('form receipt requires a corrected submission and fresh, successful browser confirmation', async t => {
	const browser = await chromium.launch();
	t.after(() => browser.close());
	for (const variant of ['matching', 'wrong reference', 'stale receipt', 'generic success', 'different submitted value']) {
		await t.test('in-page save: ' + variant, async t => {
			const site = await startFieldNotes();
			t.after(() => site.close());
			const page = await browser.newPage();
			t.after(() => page.close());
			const observer = formOutcomeObserver(page, async () => 'screenshot', { path: '/notes', form: 1 });
			await page.goto(site.url + 'notes');
			const submit = page.getByRole('button', { name: 'Add note' });
			await clickObserved(observer, submit);
			const field = page.getByLabel('Note title');
			await field.fill('QASE staging test');
			if (variant !== 'matching') {
				await page.route(site.url + 'api/notes', route => route.fulfill({
					status: 201, json: {id:'R-83', title:'QASE staging test'}
				}));
				await page.evaluate(kind => {
					const status = document.querySelector('[role=status]');
					if (kind === 'stale receipt') status.textContent = 'Note saved. Reference R-83';
					const fetchOriginal = window.fetch;
					window.fetch = async (url, options) => {
						if (kind === 'different submitted value' && options?.method === 'POST') options.body = JSON.stringify({title:'Another value'});
						const response = await fetchOriginal(url, options);
						if (kind === 'wrong reference' && options?.method === 'POST') return new Response(JSON.stringify({id:'R-830',title:'another note'}));
						return response;
					};
					if (kind === 'generic success') new MutationObserver(() => {
						if (status.textContent.startsWith('Note saved. Reference')) status.textContent = 'Note saved.';
					}).observe(status,{childList:true});
				}, variant);
			}
			await clickObserved(observer, submit);
			const [outcome] = observer.outcomes;
			assert.equal(Boolean(outcome.receipt), variant === 'matching');
			if (variant === 'matching') {
				assert.equal(site.records.length, 1);
				assert.equal(outcome.receipt.reference, site.records[0].id);
				assert.equal(outcome.receipt.status, 201);
				assert.equal(outcome.receipt.kind, 'in-page');
				assert.equal(outcome.artifactId, 'screenshot');
				assert.equal(site.observations.find(o => o.kind === 'invalid').docId, site.observations.find(o => o.kind === 'receipt displayed').docId);
			}
		});
	}
	await t.test('redirected receipt matches the only record saved by the staging form', async t => {
		const site = await startStagingForm();
		t.after(() => site.close());
		const page = await browser.newPage();
		t.after(() => page.close());
		const observer = formOutcomeObserver(page, async () => 'receipt-image');
		await page.goto(site.url);
		await page.getByRole('link', { name: 'New record' }).click();
		const button = page.getByRole('button', { name: 'Save record' });
		await clickObserved(observer, button);
		await page.getByLabel('Record name').fill('QASE form test');
		await clickObserved(observer, button);
		assert.equal(site.records.length, 1);
		const [outcome] = observer.outcomes;
		assert.equal(outcome.postStatus, 303);
		assert.deepEqual(outcome.receipt, { path: '/records/' + site.records[0].id, heading: 'Record saved', status: 200 });
	});
	for (const variant of ['confirmed', 'rejected', 'stale', 'neutral', 'other form']) {
		await t.test(variant, async () => {
			const page = await browser.newPage();
			try {
				const form = '<form method="post" action="/save"><label>Name<input required name="name"></label><button>Save</button></form>';
				await page.route('http://qa.test/**', route => {
					if (route.request().method() === 'GET') return route.fulfill({ contentType:'text/html', body:
						(variant === 'stale' ? '<p role="status">Record saved</p>' : '') + form + (variant === 'other form' ? form : '') });
					return route.fulfill({contentType:'text/html',status:variant === 'rejected' ? 422 : 200,
						body:'<h1>' + (variant === 'neutral' ? 'Continue' : 'Record saved') + '</h1>'});
				});
				await page.goto('http://qa.test/');
				const observer = formOutcomeObserver(page, async bytes => { assert.ok(bytes.length > 100); return 'receipt-image'; });
				await clickObserved(observer, page.getByRole('button').first());
				const destination = variant === 'other form' ? page.locator('form').last() : page.locator('form').first();
				await destination.getByLabel('Name').fill('QASE test record');
				await clickObserved(observer, destination.getByRole('button'));
				const [result] = observer.outcomes;
				assert.match(result.validation, /fill out/i);
				assert.equal(Boolean(result.submitted), variant !== 'other form');
				const confirmed = variant === 'confirmed';
				assert.equal(Boolean(result.receipt), confirmed);
				assert.equal(result.artifactId, confirmed ? 'receipt-image' : undefined);
				if (variant === 'rejected') assert.equal(result.postStatus, 422);
				assert.ok(!JSON.stringify(result).includes('QASE test record'), 'field values stay out of the evidence metadata');
			} finally { await page.close(); }
		});
	}
});
