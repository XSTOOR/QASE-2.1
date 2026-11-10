import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { readPageContent } from './pageContent.js';
import { createBrowserTools } from './browserTools.js';

test('page reader exposes truncation and finds late pricing without exposing form values', async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.setContent(`<main>${'Intro content '.repeat(120)}<h2>Model rates</h2><p>Input $1.40 per million tokens</p><input value="private-field-value"><textarea>private-textarea-value</textarea><select><option>private-option-value</option></select><div contenteditable="true">private-editor-value</div><div hidden>hidden-panel-value</div></main>`);
		const first = await readPageContent(page, { limit: 1000 });
		assert.equal(first.complete, false); assert.equal(first.nextOffset, 1000);
		const last = await readPageContent(page, { offset: first.nextOffset, limit: 1000 });
		assert.equal(last.complete, true); assert.equal(last.nextOffset, null);
		assert.match(last.text, /Input \$1\.40/);
		assert.doesNotMatch(first.text + last.text, /private-field-value|private-textarea-value|private-option-value|private-editor-value|hidden-panel-value/);
		await assert.rejects(() => readPageContent(page, { limit: 12001 }), /Invalid bounded/);
		const tool = createBrowserTools(() => ({ readPageContent: input => readPageContent(page, input) })).find(t => t.name === 'browser_read_page');
		assert.equal((await tool.run({ offset: -1 })).success, false);
		assert.equal((await tool.run({ script: 'ignored' })).success, false);
		assert.equal((await tool.run(null)).success, false);
		assert.equal((await tool.run([])).success, false);
	} finally { await browser.close(); }
});
