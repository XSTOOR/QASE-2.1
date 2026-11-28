import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { buildReportMarkdown } from '../report.js';
import { auditPage } from './detectors/page.js';

test('covered fields retain useful layout findings without disclosing their contents', async t => {
	const browser = await chromium.launch();
	t.after(() => browser.close());
	const page = await browser.newPage();
	const url = 'https://fixture.test/';
	const marker = 'PRIVATE-FIXTURE-VALUE';
	await page.setContent(`<title>Form</title><style>
		.row { position:relative; margin:12px; width:250px }
		.row input, textarea, select { width:200px; height:40px }
		.cover { position:absolute; inset:0; background:silver }
	</style>
	<div class="row"><input id="pass" type="password"><span class="cover"></span></div>
	<label for="email">Contact email</label>
	<div class="row"><input id="email"><span class="cover"></span></div>
	<div class="row"><textarea id="memo">${marker}</textarea><span class="cover"></span></div>
	<div class="row"><select id="choice"><option>${marker}</option></select><span class="cover"></span></div>
	<input id="visible" aria-label="Other field" style="position:fixed;left:420px;top:80px;width:180px;height:40px">`);
	for (const id of ['pass', 'email', 'visible']) await page.locator('#' + id).fill(marker, { force: true });
	const labels = [];
	let screenshot;
	const { candidates, metrics } = await auditPage(page, {
		url, viewport: 'desktop', maxScreens: 1,
		save: async (bytes, label) => { screenshot ??= bytes; labels.push(label); return 'layout-evidence'; }
	});
	const covered = candidates.filter(item => item.detector === 'page.control_obscured');
	for (const id of ['pass', 'email', 'memo', 'choice']) assert.ok(covered.some(item => item.selector === '#' + id), id);
	const markdown = buildReportMarkdown({ createdAt: 0, targetUrl: url, findings: covered });
	assert.ok(![JSON.stringify(candidates), JSON.stringify(metrics), JSON.stringify(labels), markdown].some(text => text.includes(marker)));
	assert.match(markdown, /Contact email/);
	assert.match(covered.find(item => item.selector === '#pass').title, /password/i);
	assert.ok(screenshot);
	const pixel = await page.evaluate(async base64 => {
		const bitmap = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + base64)).blob());
		const canvas = new OffscreenCanvas(1, 1);
		const ctx = canvas.getContext('2d');
		ctx.drawImage(bitmap, 430, 90, 1, 1, 0, 0, 1, 1);
		return [...ctx.getImageData(0, 0, 1, 1).data];
	}, screenshot.toString('base64'));
	assert.ok(pixel[0] > 245 && pixel[1] < 10 && pixel[2] > 245, 'adjacent populated field is masked in saved layout evidence');
});
