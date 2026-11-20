import test from 'node:test';
import assert from 'node:assert/strict';
import { isQaConversationMessage, renderQaMessageBody } from './qaConversation.js';

/** A minimal DOM: enough for the card builders, with text collected for assertions. */
function fakeDocument() {
	const make = tag => {
		const node = {
			tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {}, listeners: {}, className: '', textContent: '', innerHTML: '',
			classList: { values: new Set(), add(value) { this.values.add(value); }, contains(value) { return this.values.has(value); } },
			append(...items) { this.children.push(...items); },
			setAttribute(name, value) { this.attributes[name] = value; },
			addEventListener(type, listener) { this.listeners[type] = listener; }
		};
		return node;
	};
	return { createElement: make };
}
const text = node => [node.textContent, node.innerHTML, ...(node.children ?? []).map(text)].filter(Boolean).join(' ');
const find = (node, predicate) => predicate(node) ? node : (node.children ?? []).map(child => find(child, predicate)).find(Boolean);

const session = {
	id: 'run-1', mode: 'qa', targetUrl: 'https://shop.test/',
	findings: [{ id: 'f1', severity: 'high', category: 'layout', title: 'Text overlaps other text', url: 'https://shop.test/pricing', viewports: ['desktop', 'mobile'], actual: 'Two headings collide.', expected: 'No overlap', steps: ['Open /pricing'], artifactId: 'ART-1', fix: 'Use flex gap.' }],
	report: { verdict: 'fail', summary: 'One serious layout defect.', bySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 }, notCovered: ['Signed-in pages were not tested.'] }
};

test('only QA engine messages are rendered as conversation cards', () => {
	assert.equal(isQaConversationMessage({ role: 'agent', kind: 'qa-step' }, session), true);
	assert.equal(isQaConversationMessage({ role: 'assistant', kind: 'qa-report' }, session), true, 'older runs stored role "assistant"');
	assert.equal(isQaConversationMessage({ role: 'agent', kind: 'qa-step' }, { ...session, mode: 'sqa' }), false);
	assert.equal(isQaConversationMessage({ role: 'user', kind: 'qa-step' }, session), false);
});

test('a finding message becomes a card with severity, place, screenshot and a fix-prompt button', () => {
	const doc = fakeDocument();
	const opened = [];
	const card = renderQaMessageBody({ id: 'qaf-f1', role: 'agent', kind: 'qa-finding', text: '**HIGH** · Text overlaps other text' }, session, { onOpen: id => opened.push(id) }, { doc });
	assert.equal(card.dataset.severity, 'high');
	const content = text(card);
	assert.match(content, /Text overlaps other text/);
	assert.match(content, /\/pricing · desktop, mobile/);
	assert.ok(find(card, node => node.tagName === 'IMG' && node.src === '/api/sessions/run-1/artifacts/ART-1'), 'screenshot thumbnail');
	assert.ok(find(card, node => node.textContent === 'Copy fix prompt'));
	find(card, node => node.textContent === 'Details').listeners.click();
	assert.deepEqual(opened, ['f1']);
});

test('the report message becomes a verdict card with counts, gaps and actions', () => {
	const doc = fakeDocument();
	const card = renderQaMessageBody({ id: 'qa-report-1', role: 'agent', kind: 'qa-report', text: 'summary' }, session, { onOpenReport() {}, onDownloadPdf() {}, onCopyAll() {} }, { doc });
	const content = text(card);
	assert.equal(card.dataset.verdict, 'fail');
	assert.match(content, /Fail/);
	assert.match(content, /One serious layout defect/);
	assert.match(content, /Not tested \(1\)/);
	for (const label of ['Open full report', 'Download PDF', 'Copy all fix prompts']) assert.ok(find(card, node => node.textContent === label), label);
});

test('step messages and cards whose data is missing fall back to markdown text', () => {
	const doc = fakeDocument();
	const body = renderQaMessageBody({ id: 'qaf-missing', role: 'agent', kind: 'qa-finding', text: '**HIGH** · Gone' }, session, {}, { doc, markdown: value => `<p>${value}</p>` });
	assert.equal(body.innerHTML, '<p>**HIGH** · Gone</p>');
	const step = renderQaMessageBody({ id: 's', role: 'agent', kind: 'qa-step', text: 'Crawled 3 pages.' }, { ...session, report: undefined }, {}, { doc, markdown: value => value });
	assert.equal(step.innerHTML, 'Crawled 3 pages.');
});
