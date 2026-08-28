import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const founderView = readFileSync(new URL('../public/founderView.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

test('feature dock exposes one accessible launcher per mode outside the working panels', () => {
	assert.match(html, /<nav class="feature-dock" aria-label="Qase features">/);
	for (const [id, label, feature, tip] of [
		['new-run', 'Start standard QA run', 'qa', 'feature-tip-qa'],
		['new-sqa', 'Start SQA assessment', 'sqa', 'feature-tip-sqa'],
		['new-founder', 'Start Founder Mode review', 'founder', 'feature-tip-founder']
	]) {
		assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length, 1);
		assert.match(html, new RegExp(`id="${id}"[^>]+aria-label="${label}"[^>]+aria-describedby="${tip}"[^>]+data-feature="${feature}"`));
		assert.match(html, new RegExp(`id="${tip}"[^>]+role="tooltip"`));
	}
	assert.ok(html.indexOf('class="feature-dock"') > html.indexOf('class="panel viewer"'), 'dock follows the intact viewer panel');
	assert.doesNotMatch(html.slice(html.indexOf('class="panel runs"'), html.indexOf('class="panel chat"')), /id="new-(?:run|sqa|founder)"/);
});

test('Founder launcher matches the authenticated API input contract and limits', () => {
	assert.match(html, /<dialog[^>]+id="founder-start"[^>]+aria-labelledby="founder-start-title"/);
	for (const [id, maximum] of [
		['founder-target-name', 200],
		['founder-target-release', 200],
		['founder-target-environment', 100],
		['founder-target-url', 8192],
		['founder-stage', 200],
		['founder-business-model', 500],
		['founder-target-customer', 1000],
		['founder-primary-goal', 1000],
		['founder-constraints', 2000]
	]) assert.match(html, new RegExp(`id="${id}"[^>]+maxlength="${maximum}"`));
	assert.match(html, /id="founder-target-name"[^>]+required/);
	assert.match(html, /id="founder-target-url"[^>]+type="url"[^>]+required/);
	assert.match(html, /id="founder-authorization"[^>]+type="checkbox"[^>]+required/);
	assert.match(html, /id="founder-competitors"[^>]+aria-describedby="founder-competitors-note"/);
	assert.match(html, /id="founder-catalog-meta"[^>]+aria-live="polite"/);
	assert.match(html, /id="tab-founder"[^>]+role="tab"[^>]+aria-controls="pane-founder"[^>]+hidden/);
	assert.match(html, /id="pane-founder"[^>]+role="tabpanel"[^>]+aria-labelledby="tab-founder"/);
});

test('Founder frontend creates an idle scope, then starts through the existing message endpoint', () => {
	assert.match(app, /api\('\/founder\/catalog'\)/);
	assert.match(app, /api\('\/founder\/sessions',\s*\{\s*method:\s*'POST'/);
	assert.match(app, /authorizationConfirmed:\s*true/);
	assert.match(app, /target,\s*device:[^,]+,\s*deviceLandscape:[^,]+,\s*\.\.\.\(Object\.keys\(productContext\)\.length/);
	assert.match(app, /api\(`\/sessions\/\$\{session\.id\}\/message`,\s*\{/);
	assert.match(app, /JSON\.stringify\(\{ text: `Review \$\{targetUrl\}` \}\)/);
	assert.match(app, /case 'founder\.created':/);
	assert.match(app, /case 'founder\.target_bound':/);
	assert.match(app, /case 'founder\.observation':/);
	assert.match(app, /case 'founder\.finalized':/);
	assert.match(app, /toast\('Founder brief published\.', 'good'\)/);
});

test('Founder result rendering is safe, mode-scoped, and covers the full decision brief', () => {
	const renderer = founderView;
	assert.ok(renderer.length > 10_000, 'Founder renderer block should be discoverable');
	assert.doesNotMatch(renderer, /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/);
	assert.match(renderer, /session\?\.mode !== 'founder'/);
	for (const heading of [
		'Executive thesis',
		'UI, UX & product findings',
		'ICP & positioning',
		'Sales & GTM',
		'Marketing & growth',
		'Monetization & pricing',
		'Prioritized opportunities',
		'Quick wins',
		'30 \/ 60 \/ 90 roadmap',
		'Risks & assumptions',
		'Metrics & experiments',
		'Evidence confidence'
	]) assert.match(renderer, new RegExp(heading));
	assert.match(renderer, /declared\?\.limitation/);
	assert.match(renderer, /declared\?\.assumptionCount/);
	assert.match(renderer, /monetization\.pricingPresentation/);
	assert.match(renderer, /founderTrace\(item\)/);
	assert.match(renderer, /function renderFounderReportActions\(\)/);
	assert.match(renderer, /setAttribute\('role', 'group'\)/);
	assert.match(renderer, /apiText\(`\/sessions\/\$\{getSessionId\(\)\}\/report\.md`\)/);
	assert.match(renderer, /qase-founder-review\.md/);
	assert.match(renderer, /Founder report copied to the clipboard\./);
	assert.match(renderer, /appendFounderCompletedReport\(elements\.founderView, founder, report\)/);
	assert.match(app, /createFounderView\(\{/);
	assert.match(app, /const renderFounder = founderView\.render/);
});

test('the generic Report tab renders the finalized Founder brief and live finalization updates it', () => {
	const reportRenderer = app.slice(app.indexOf('function renderReport()'), app.indexOf('function renderSqaReportTab()'));
	assert.match(reportRenderer, /if \(state\.session\?\.mode === 'founder'\) \{\s*renderFounderReportTab\(\);\s*return;/);
	assert.match(app, /const renderFounderReportTab = founderView\.renderReportTab/);
	assert.match(founderView, /function renderReportTab\(\)/);
	assert.match(founderView, /if \(!founder\.finalizedAt \|\| !report\)/);
	assert.match(founderView, /appendFounderCompletedReport\(elements\.reportView, founder, report\)/);
	assert.match(app, /case 'founder\.finalized':[\s\S]*?renderFounder\(\);\s*renderReport\(\);/);
});

test('feature dock reserves a fourth desktop column and becomes a bottom dock responsively', () => {
	assert.match(styles, /@media \(min-width: 1281px\)[\s\S]*?\.cli-theme \.app\s*\{[\s\S]*?grid-template-columns:[^;]+58px;/);
	assert.match(styles, /@media \(max-width: 1280px\) and \(min-width: 1101px\)[\s\S]*?\.cli-theme \.app\s*\{[\s\S]*?grid-template-columns:[^;]+56px;/);
	assert.match(styles, /@media \(max-width: 1100px\)[\s\S]*?\.feature-dock\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?bottom:\s*9px;/);
	assert.match(styles, /\.feature-action:focus-visible \.feature-tooltip/);
	assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.feature-tooltip/);
	assert.match(styles, /\.founder-evidence-grid/);
	assert.match(styles, /\.founder-boundary/);
});
