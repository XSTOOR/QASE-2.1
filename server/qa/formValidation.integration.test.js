import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { testForms } from './detectors/forms.js';

test('custom required-field validation in Chromium', async t => {
	const browser = await chromium.launch();
	t.after(() => browser.close());
	const variants = {
		'native required': 'passed',
		'linked error': 'passed', 'delayed error': 'passed', 'field wrapper': 'passed', 'cancelled click': 'passed',
		'missing error': 'failed', 'transparent error': 'failed', 'other form alert': 'inconclusive',
		'unchanged hint': 'inconclusive', 'prefilled': 'inconclusive', 'attempted submission': 'failed',
		'client-side acceptance': 'failed', 'neutral notification': 'inconclusive', 'old success notification': 'inconclusive'
	};
	await Promise.all(Object.entries(variants).map(async ([variant, expected]) => {
		const page = await browser.newPage();
		try {
			const url = 'https://sample.test/contact';
			let posts = 0;
			await page.route('https://sample.test/**', route => {
				if (route.request().method() === 'POST') { posts++; return route.abort(); }
				return route.fulfill({ contentType: 'text/html', body: '<form method="post" action="/save" novalidate><div><label for="name">Name</label><input id="name" aria-required="true"><span id="err"></span></div><button>Submit</button></form><form id="other"><p role="alert"></p></form>' });
			});
			const reload = async () => {
				await page.goto(url);
				await page.evaluate(kind => {
					const form = document.forms[0], field = form.elements[0], error = document.getElementById('err');
					if (kind === 'native required') {
						form.noValidate = false;
						field.required = true;
						return;
					}
					if (['client-side acceptance', 'neutral notification', 'old success notification'].includes(kind)) {
						error.setAttribute('role', 'alert');
						if (kind === 'old success notification') error.textContent = 'Saved successfully';
						form.onsubmit = event => {
							event.preventDefault();
							error.textContent = kind === 'neutral notification' ? 'Checking details' : 'Saved successfully';
						};
						return;
					}
					if (kind === 'field wrapper') error.className = 'field-error';
					else if (kind === 'unchanged hint') { field.setAttribute('aria-describedby', 'err'); error.textContent = 'Use your legal name.'; }
					else if (kind !== 'other form alert') field.setAttribute('aria-errormessage', 'err');
					if (kind === 'prefilled') field.value = 'Already filled';
					const showError = () => {
						field.setAttribute('aria-invalid', 'true');
						if (kind === 'other form alert') { document.querySelector('#other p').textContent = 'Unrelated error'; return; }
						if (kind === 'unchanged hint' || kind === 'missing error') return;
						error.textContent = 'Enter your name.';
						if (kind === 'transparent error') error.style.opacity = '0';
					};
					const respond = event => {
						event.preventDefault();
						if (kind === 'attempted submission') fetch('/save', { method: 'POST' }).catch(() => {});
						if (kind === 'delayed error') setTimeout(showError, 150); else showError();
					};
					if (kind === 'cancelled click') form.querySelector('button').onclick = respond; else form.onsubmit = respond;
				},variant);
			};
			await reload();
			const { requiredChecks, candidates } = await testForms(page, { url, viewport: 'desktop', blocked: () => posts, browser: { interact: work => work() }, reload,
				save: async bytes => { assert.ok(bytes.length > 100); return 'form-evidence'; } });
			assert.equal(requiredChecks.length, 1, variant);
			const [check] = requiredChecks;
			assert.equal(check.status, expected, variant + ': ' + check.detail);
			if (expected === 'passed') {
				assert.equal(check.field, 'Name');
				assert.match(check.detail, variant === 'native required' ? /fill out this field/i : /Enter your name/);
				assert.equal(check.artifactId, 'form-evidence');
				assert.equal(candidates.length, 0);
			}
			if (['missing error', 'transparent error'].includes(variant)) assert.ok(candidates.some(item => item.detector === 'forms.silent_rejection' && item.artifactId));
			if (variant === 'attempted submission') assert.ok(candidates.some(item => item.detector === 'forms.no_validation' && item.artifactId));
			if (variant === 'client-side acceptance') {
				assert.match(check.detail, /reported “Saved successfully”/);
				assert.ok(candidates.some(item => item.detector === 'forms.no_validation' && item.artifactId));
			}
			if (variant === 'prefilled') assert.equal(candidates.length, 0);
			assert.equal(posts, variant === 'attempted submission' ? 1 : 0);
		} finally { await page.close(); }
	}));
});
