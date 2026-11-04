import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

test('Quality launcher exposes an accessible recommended review with optional advanced scope', () => {
	assert.match(html, /id="new-sqa"[^>]+aria-label="Start quality review"[^>]+data-feature="sqa"/);
	assert.match(html, /class="feature-label">SQA<\/span>/);
	assert.match(html, /<dialog[^>]+id="sqa-start"[^>]+aria-labelledby="sqa-start-title"/);
	assert.match(html, /id="sqa-authorization"[^>]+type="checkbox"[^>]+required/);
	assert.match(html, /id="sqa-target-url"[^>]+type="url"[^>]+required/);
	assert.match(html, /id="sqa-customize"/);
	assert.match(html, /id="sqa-selection-summary"[^>]+aria-live="polite"/);
	assert.match(html, /id="sqa-selection-reasons"[^>]+aria-label="Why these controls are selected"/);
	assert.doesNotMatch(html, /id="sqa-target-name"[^>]+required/);
	for (const id of ['sqa-target-release', 'sqa-target-environment']) {
		assert.match(html, new RegExp(`id="${id}"[^>]+required`));
	}
	assert.match(html, /id="sqa-target-release"[^>]+placeholder="2026\.11\.2\+abc123"/);
	assert.match(html, /id="sqa-catalog-retry"[^>]+hidden>Retry catalog/);
	assert.match(html, /id="tab-sqa"[^>]+role="tab"[^>]+aria-controls="pane-sqa"/);
	assert.match(html, /id="pane-sqa"[^>]+role="tabpanel"[^>]+aria-labelledby="tab-sqa"/);
	assert.match(html, /id="sqa-scope-guidance"[^>]+role="note"/);
	assert.match(html, /Some standards require documents, approvals, security reports, or independent review/);
});

test('SQA frontend uses the authenticated API contract and safe DOM construction', () => {
	assert.match(app, /api\('\/sqa\/catalog'\)/);
	assert.match(app, /api\('\/sqa\/sessions',\s*\{\s*method:\s*'POST'/);
	assert.match(app, /authorizationConfirmed:\s*true/);
	assert.match(app, /SQA_REQUIRED_BROWSER_ATTRIBUTES\.includes\(id\)/);
	assert.match(app, /Required for URL-based browser review/);
	assert.match(app, /describeSqaScopeSelection\(state\.sqaCatalog/);
	assert.match(app, /catalogRetry\.onclick = \(\) => void refreshSqaCatalog\(\{ force: true \}\)/);
	assert.match(app, /Choose an available device and browser before starting the quality review/);
	assert.doesNotMatch(app, /sqaUi\.targetRelease\.value\.trim\(\) \|\| 'Current'/);
	assert.doesNotMatch(app, /sqaUi\.targetEnvironment\.value\.trim\(\) \|\| 'Preview'/);
	assert.match(app, /api\(`\/sessions\/\$\{session\.id\}\/message`,\s*\{/);
	assert.match(app, /JSON\.stringify\(\{\s*text:\s*targetUrl\s*\}\)/);
	assert.match(app, /case 'sqa':/);
	assert.match(app, /if \(event\.final\) session\.sqa\.finalizedAt/);
	assert.match(app, /else delete session\.sqa\.finalizedAt/);
	assert.match(app, /if \(event\.final && \(!event\.review \|\| event\.review\.status === 'published'\)\) toast\('Quality review published\.'/);
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
	assert.match(app, /encrypted locally for this run and deleted when the run ends/i);
	assert.doesNotMatch(app, /Held in this server's memory only/);
	assert.match(styles, /\.sqa-technical-summary/);
	assert.match(styles, /\.sqa-unresolved-group/);
	assert.match(styles, /\.sqa-selection-reasons/);
});

test('finalized SQA assessments expose professional report export actions', () => {
	assert.match(app, /if \(lifecycle\.finalized\) el\.sqaView\.append\(renderSqaReportActions\(\)\)/);
	assert.match(app, /function renderSqaReportActions\(\)/);
	assert.match(app, /aria-label', 'Quality review report actions'/);
	assert.match(app, /apiText\(`\/sessions\/\$\{state\.sessionId\}\/report\.md`\)/);
	assert.match(app, /qase-sqa-assessment\.md/);
	assert.match(app, /downloadReportPdf\('qase-sqa-assessment\.pdf'\)/);
	assert.match(app, /Quality review copied to the clipboard/);
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
