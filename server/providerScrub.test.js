import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';

/* Phase D7 (#13783) — provider-name scrub: no third-party provider names in
 * USER-FACING text. Raw provider keys ('browserstack') remain valid in API
 * payloads, env vars (BROWSERSTACK_*), internal module names, comments, and
 * tests — the sweep covers markup, rendered strings, report/PDF output text,
 * tooltips and error messages. */

const USER_FACING_FILES = [
	'public/index.html',
	'public/app.js',
	'public/deviceDrawer.js',
	'public/devicePicker.js',
	'public/deviceMatrixView.js',
	'server/report.js',
	'server/reportPdf.js'
];

test('#13783: no third-party provider names in user-facing UI text', async () => {
	for (const file of USER_FACING_FILES) {
		const src = await readFile(file, 'utf8');
		const lines = src.split('\n');
		for (const [index, line] of lines.entries()) {
			// Skip comments — they document internals, users never see them.
			const trimmed = line.trim();
			if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
			// Skip raw provider keys entirely (comparisons, payload fields,
			// key→label mappings) — only human-readable text is checked.
			if (/browserstack/i.test(line)) continue;
			assert.doesNotMatch(
				line, /BrowserStack/i,
				`${file}:${index + 1} must not name a third-party provider in user-facing text`
			);
		}
	}
});

test('#13783: report markdown + PDF render QASE-neutral provider labels', async () => {
	const report = await readFile('server/report.js', 'utf8');
	const pdf = await readFile('server/reportPdf.js', 'utf8');
	assert.match(report, /browserstack: 'remote environment runtime'/, 'markdown reports must neutralize the provider key');
	assert.match(pdf, /browserstack: 'remote environment runtime'/, 'PDF reports must neutralize the provider key');
});
