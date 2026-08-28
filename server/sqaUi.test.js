import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

test('SQA launcher exposes an accessible, authorization-gated scope dialog and result tab', () => {
	assert.match(html, /id="new-sqa"[^>]+aria-label="Start SQA assessment"[^>]+data-feature="sqa"/);
	assert.match(html, /class="feature-label">SQA<\/span>/);
	assert.match(html, /<dialog[^>]+id="sqa-start"[^>]+aria-labelledby="sqa-start-title"/);
	assert.match(html, /id="sqa-authorization"[^>]+type="checkbox"[^>]+required/);
	for (const id of ['sqa-target-name', 'sqa-target-url', 'sqa-target-release', 'sqa-target-environment']) {
		assert.match(html, new RegExp(`id="${id}"[^>]+required`));
	}
	assert.match(html, /id="sqa-target-url"[^>]+type="url"/);
	assert.match(html, /id="tab-sqa"[^>]+role="tab"[^>]+aria-controls="pane-sqa"/);
	assert.match(html, /id="pane-sqa"[^>]+role="tabpanel"[^>]+aria-labelledby="tab-sqa"/);
	assert.match(html, /id="sqa-scope-guidance"[^>]+role="note"/);
	assert.match(html, /Sector profiles and broad or all-attribute selections also require external artifacts/);
	assert.match(html, /Authenticated workflows may require test credentials/);
});

test('SQA frontend uses the authenticated API contract and safe DOM construction', () => {
	assert.match(app, /api\('\/sqa\/catalog'\)/);
	assert.match(app, /api\('\/sqa\/sessions',\s*\{\s*method:\s*'POST'/);
	assert.match(app, /authorizationConfirmed:\s*true/);
	assert.match(app, /api\(`\/sessions\/\$\{session\.id\}\/message`,\s*\{/);
	assert.match(app, /JSON\.stringify\(\{\s*text:\s*targetUrl\s*\}\)/);
	assert.match(app, /case 'sqa':/);
	assert.match(app, /if \(event\.final\) session\.sqa\.finalizedAt/);
	assert.match(app, /else delete session\.sqa\.finalizedAt/);
	assert.match(app, /if \(event\.final\) toast\('SQA assessment published\.'/);
	const renderer = app.slice(app.indexOf('function renderSqa()'), app.indexOf('function connect(id)'));
	assert.ok(renderer.length > 1_000, 'SQA renderer block should be discoverable');
	assert.doesNotMatch(renderer, /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/);
	assert.match(renderer, /\['http:', 'https:'\]\.includes\(candidate\.protocol\)/);
	assert.match(renderer, /node\.rel = 'noreferrer noopener'/);
	assert.match(styles, /\.sqa-modal/);
	assert.match(styles, /\.sqa-verdict\[data-status="blocked"\]/);
	assert.match(app, /function renderSqaTechnicalSummary\(summary\)/);
	assert.match(app, /'Automated web checks'/);
	assert.match(app, /'Reviewer evidence required'/);
	assert.match(app, /'Mixed evidence incomplete'/);
	assert.match(app, /'Automated check blocked \/ not run'/);
	assert.match(app, /Deterministic verdict: Blocked\. No control failures were recorded/);
	assert.match(styles, /\.sqa-technical-summary/);
	assert.match(styles, /\.sqa-unresolved-group/);
});

test('finalized SQA assessments expose professional report export actions', () => {
	assert.match(app, /if \(lifecycle\.finalized && assessment\) el\.sqaView\.append\(renderSqaReportActions\(\)\)/);
	assert.match(app, /function renderSqaReportActions\(\)/);
	assert.match(app, /aria-label', 'SQA assessment report actions'/);
	assert.match(app, /apiText\(`\/sessions\/\$\{state\.sessionId\}\/report\.md`\)/);
	assert.match(app, /qase-sqa-assessment\.md/);
	assert.match(app, /downloadReportPdf\('qase-sqa-assessment\.pdf'\)/);
	assert.match(app, /SQA assessment copied to the clipboard/);
});

test('the generic Report tab renders finalized SQA assessments instead of checking the QA report field', () => {
	const reportRenderer = app.slice(app.indexOf('function renderReport()'), app.indexOf('function renderSqaReportTab()'));
	const sqaReportRenderer = app.slice(app.indexOf('function renderSqaReportTab()'), app.indexOf('/* ── Event stream'));
	assert.match(reportRenderer, /if \(state\.session\?\.mode === 'sqa'\) \{\s*renderSqaReportTab\(\);\s*return;/);
	assert.match(sqaReportRenderer, /function renderSqaReportTab\(\)/);
	assert.match(sqaReportRenderer, /if \(!lifecycle\.finalized \|\| !assessment\)/);
	assert.match(sqaReportRenderer, /renderSqaVerdict\(assessment, lifecycle\)/);
	assert.match(sqaReportRenderer, /renderSqaReportActions\(\)/);
	assert.match(app, /case 'sqa':[\s\S]*?renderSqa\(\);\s*renderReport\(\);/);
	assert.match(app, /window\.setTimeout\(\(\) => URL\.revokeObjectURL\(url\), 0\)/);
});
