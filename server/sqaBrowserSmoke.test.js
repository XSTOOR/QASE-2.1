import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { startMediaFixture } from '../scripts/fixtures/media-site.mjs';
import { createSqaBrowserSmoke, SQA_SMOKE_LIMITS } from './sqaBrowserSmoke.js';

async function withPage(html, run) {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
		await page.setContent(html);
		return await run(page);
	} finally {
		await browser.close();
	}
}

test('accessibility smoke samples a bounded real keyboard path and reverse focus', async () => {
	await withPage(`<!doctype html><html><body>
		<a href="#main">Skip</a><button aria-label="Start practice">Start</button>
		<input name="email" placeholder="Email"><a href="/privacy">Privacy</a>
	</body></html>`, async page => {
		const result = await createSqaBrowserSmoke(page).accessibility({ steps: 4, reverseSteps: 1 });
		assert.equal(result.success, true);
		assert.equal(result.focusSequence.length, 5);
		assert.equal(result.uniqueForwardTargets, 4);
		assert.equal(result.noFocusSteps, 0);
		assert.match(result.inputMethod, /keyboard\.press/);
		assert.equal(result.focusSequence.at(-1).direction, 'reverse');
		assert.equal(result.focusSequence.some(item => item.element?.name === 'Start practice'), true);
	});
});

test('responsive smoke detects narrow overflow and restores the original viewport', async () => {
	await withPage(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
		<body><main style="width:700px"><button style="margin-left:620px">Continue</button></main></body></html>`, async page => {
		const before = page.viewportSize();
		const result = await createSqaBrowserSmoke(page).responsive({
			viewports: [{ width: 390, height: 844 }, { width: 800, height: 700 }]
		});
		assert.equal(result.success, true);
		assert.ok(result.samples[0].horizontalOverflowPx > 0);
		assert.ok(result.samples[0].outsideViewportInteractiveCount > 0);
		assert.equal(result.samples[1].horizontalOverflowPx, 0);
		assert.deepEqual(result.restoredViewport, before);
		assert.deepEqual(page.viewportSize(), before);
	});
});

test('smoke inputs are strictly bounded', async () => {
	await withPage('<button>Only control</button>', async page => {
		const smoke = createSqaBrowserSmoke(page);
		const keyboard = await smoke.accessibility({ steps: 999, reverseSteps: 999 });
		assert.equal(keyboard.steps, SQA_SMOKE_LIMITS.maxKeyboardSteps);
		assert.equal(keyboard.reverseSteps, SQA_SMOKE_LIMITS.maxReverseSteps);
		await assert.rejects(() => smoke.responsive({ viewports: Array.from({ length: 4 }, () => ({ width: 390, height: 844 })) }), /1-3/);
		await assert.rejects(() => smoke.responsive({ viewports: [{ width: 100, height: 200 }] }), /320-2560/);
	});
});

test('navigation smoke samples exact same-origin links and restores the page', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
		await page.route('http://fixture.test/**', async route => {
			const url = new URL(route.request().url());
			const body = url.pathname === '/privacy'
				? '<h1>Privacy</h1><a href="/">Back</a>'
				: '<h1>Studio</h1><a href="/privacy">Privacy</a><a href="/#pricing">Pricing</a>';
			await route.fulfill({ status: 200, contentType: 'text/html', body });
		});
		await page.goto('http://fixture.test/');
		const result = await createSqaBrowserSmoke(page).navigation({ links: ['Privacy', 'Pricing'] });
		assert.equal(result.success, true);
		assert.equal(result.samples.length, 2);
		assert.equal(result.samples.every(sample => sample.ok), true);
		assert.equal(result.samples[0].heading, 'Privacy');
		assert.equal(result.samples[1].heading, 'Studio');
		assert.equal(result.restoredUrl, 'http://fixture.test/');
	} finally {
		await browser.close();
	}
});

test('form smoke discovers one safe form, runs generated cases, and detects stale success recovery state', async () => {
	await withPage(`<!doctype html><html><body>
		<form><label>Work email <input type="email" required></label><button type="submit">Validate email</button></form>
		<output role="status"></output>
		<script>document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); document.querySelector('output').textContent = 'Email format accepted locally.'; });</script>
	</body></html>`, async page => {
		const result = await createSqaBrowserSmoke(page).formValidation();
		assert.equal(result.success, true);
		assert.equal(result.eligible, true);
		assert.deepEqual(result.discovery, { automatic: true, eligibleForms: 1 });
		assert.equal(result.field.label, 'Work email');
		assert.deepEqual(result.cases.map(item => item.name), ['empty', 'invalid_email', 'valid_email', 'invalid_after_valid']);
		assert.equal(result.cases[0].validity.valid, false);
		assert.ok(result.cases[0].validity.failures.includes('valueMissing'));
		assert.ok(result.cases[1].validity.failures.includes('typeMismatch'));
		assert.equal(result.cases[2].validity.valid, true);
		assert.equal(result.staleSuccessSignalAfterInvalid, true);
		assert.equal(await page.getByLabel('Work email').inputValue(), '');
	});
});

test('form smoke returns one deterministic blocker when no eligible email form exists', async () => {
	await withPage(`<!doctype html><html><body>
		<form><label>Describe your idea <input type="text"></label><button type="submit">Continue</button></form>
	</body></html>`, async page => {
		const result = await createSqaBrowserSmoke(page).formValidation();
		assert.equal(result.success, true);
		assert.equal(result.eligible, false);
		assert.equal(result.outcome, 'unavailable');
		assert.equal(result.code, 'FORM_SMOKE_NO_ELIGIBLE_FORM');
		assert.match(result.blockerReason, /inspected 1 form.*no email field/i);
		assert.deepEqual(result.inspection, {
			formsScanned: 1,
			emailFields: 0,
			labeledEmptyEmailFields: 0,
			eligibleForms: 0,
			rejectionCodes: []
		});
		assert.deepEqual(result.cases, []);
		assert.equal(await page.getByLabel('Describe your idea').inputValue(), '');
	});
});

test('controlled qualification fixture clears success state when email becomes invalid again', async () => {
	const fixture = await startMediaFixture();
	let browser;
	try {
		browser = await chromium.launch();
		const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
		await page.goto(fixture.url);
		const result = await createSqaBrowserSmoke(page).formValidation({
			fieldLabel: 'Work email',
			submitName: 'Validate email'
		});
		assert.equal(result.success, true);
		assert.equal(result.staleSuccessSignalAfterInvalid, false);
		const recoverySignals = result.cases.find(item => item.name === 'invalid_after_valid')?.statusSignals ?? [];
		assert.equal(recoverySignals.some(signal => /accepted locally/i.test(signal.text)), false);
	} finally {
		await browser?.close();
		await fixture.close();
	}
});

test('form smoke refuses POST forms and prefilled fields', async () => {
	await withPage('<form method="post"><label>Email <input type="email" required></label><button>Send</button></form>', async page => {
		const result = await createSqaBrowserSmoke(page).formValidation({ fieldLabel: 'Email', submitName: 'Send' });
		assert.equal(result.success, false);
		assert.equal(result.code, 'FORM_SMOKE_UNSAFE_SUBMISSION');
	});
	await withPage('<form><label>Email <input type="email" value="private@example.test"></label><button>Validate</button></form>', async page => {
		const result = await createSqaBrowserSmoke(page).formValidation({ fieldLabel: 'Email', submitName: 'Validate' });
		assert.equal(result.success, false);
		assert.equal(result.code, 'FORM_SMOKE_NONEMPTY_FIELD');
	});
});
