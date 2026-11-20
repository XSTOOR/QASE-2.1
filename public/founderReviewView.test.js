import test from 'node:test';
import assert from 'node:assert/strict';
import { founderBadge, isFounderReviewRun, renderFounderReview, renderFounderReportCard, renderFounderRecCard, renderLegacyFounderNotice } from './founderReviewView.js';
import { isQaConversationMessage, renderQaMessageBody } from './qaConversation.js';
import { createFounderReviewFixture } from '../server/founder/fixtureReview.js';

function fakeDocument() {
	const make = tag => ({
		tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {}, listeners: {}, style: {}, className: '', textContent: '', innerHTML: '',
		append(...items) { this.children.push(...items.map(item => typeof item === 'string' ? { textContent: item, children: [] } : item)); },
		replaceChildren(...items) { this.children = []; this.append(...items); },
		setAttribute(name, value) { this.attributes[name] = value; },
		addEventListener(type, listener) { this.listeners[type] = listener; }
	});
	return { createElement: make };
}
const text = node => [node.textContent, ...(node.children ?? []).map(text)].filter(Boolean).join(' ');
const findAll = (node, predicate, out = []) => { if (predicate(node)) out.push(node); for (const child of node.children ?? []) findAll(child, predicate, out); return out; };
const byClass = (root, name) => findAll(root, item => String(item.className ?? '').split(/\s+/).includes(name));

const finished = await createFounderReviewFixture();

test('only Founder engine runs use the business view; earlier reviews get a read-only notice', () => {
	assert.equal(isFounderReviewRun(finished), true);
	assert.equal(isFounderReviewRun({ mode: 'founder', founder: { scope: {} } }), false);
	assert.equal(isFounderReviewRun({ mode: 'sqa', sqa: { version: 3 } }), false);
	assert.equal(founderBadge(finished), String(finished.founder.report.readiness));
	assert.equal(founderBadge({ mode: 'qa' }), '');
	const notice = renderLegacyFounderNotice({ mode: 'founder', founder: {} }, fakeDocument());
	assert.match(text(notice), /previous Founder pipeline/);
});

test('the finished review leads with readiness, verdict, positioning and recommendations grouped by priority', () => {
	const view = renderFounderReview(finished, { artifactUrl: id => `/api/artifacts/${id}`, onDownloadPdf() {}, onDownloadMarkdown() {} }, fakeDocument());
	const all = text(view);
	const { report } = finished.founder;
	assert.match(all, new RegExp(`${report.readiness}`));
	assert.match(all, /Not ready to scale/);
	assert.match(all, /helps small agencies/, 'suggested positioning is shown');
	assert.match(all, /Client projects, delivered on time/, 'headline options are shown');
	const groups = byClass(view, 'fdr-rec-group').map(group => group.className);
	assert.deepEqual(groups.map(name => name.match(/is-(\w+)/)[1]), ['now', 'next', 'later']);
	const recs = byClass(view, 'fdr-rec');
	assert.equal(recs.length, report.recommendations.length);
	assert.match(text(recs[0]), /R1/);
	assert.ok(byClass(view, 'fdr-kind-avoid').length >= 1, 'what not to do is marked');
	assert.match(all, /Clean, uncluttered layout/, 'what to keep is shown');
	assert.equal(byClass(view, 'fdr-lens').length, 10, 'all ten business lenses are on the scorecard');
	assert.match(all, /Asana/);
	assert.match(all, /Pricing page is missing/, 'journey friction is shown');
	assert.ok(findAll(view, item => item.tagName === 'BUTTON' && /Download PDF/.test(item.textContent)).length);
});

test('the Studio bar selects do-now items and sends only when bound with a selection', () => {
	const calls = [];
	const handoff = {
		status: { bound: true, state: { selections: [] } },
		onSelect: ids => calls.push(['select', ids]), onSend: () => calls.push(['send']), onExport: how => calls.push(['export', how]), onToggle: (id, on) => calls.push(['toggle', id, on])
	};
	const view = renderFounderReview(finished, { handoff }, fakeDocument());
	const buttons = findAll(view, item => item.tagName === 'BUTTON');
	const send = buttons.find(item => item.textContent === 'Send to Studio');
	assert.equal(send.disabled, true, 'nothing selected yet');
	buttons.find(item => item.textContent === 'Select do-now').listeners.click({});
	const nowIds = finished.founder.report.recommendations.filter(item => item.priority === 'now').map(item => item.id);
	assert.deepEqual(calls[0], ['select', nowIds]);
	const boxes = findAll(view, item => item.tagName === 'INPUT');
	assert.equal(boxes.length, finished.founder.report.recommendations.length);
	boxes[1].checked = true; boxes[1].listeners.change();
	assert.deepEqual(calls[1], ['toggle', 'R2', true]);

	const selectedView = renderFounderReview(finished, { handoff: { ...handoff, status: { bound: true, state: { selections: ['R1'] } } } }, fakeDocument());
	assert.equal(findAll(selectedView, item => item.tagName === 'BUTTON' && item.textContent === 'Send to Studio')[0].disabled, false);
	const automatic = renderFounderReview(finished, { handoff: { ...handoff, status: { bound: true, state: { automaticHandoff: true, selections: [] } } } }, fakeDocument());
	assert.equal(findAll(automatic, item => item.tagName === 'INPUT').length, 0, 'automatic handoff has no manual selection');
});

test('a running review shows its stages and no recommendations yet', () => {
	const running = structuredClone(finished);
	running.status = 'running';
	delete running.founder.report; delete running.founder.finalizedAt;
	running.founder.phases = { open: { status: 'done', detail: '6 pages' }, brief: { status: 'done' }, understand: { status: 'running' } };
	const view = renderFounderReview(running, {}, fakeDocument());
	assert.match(text(view), /Recommendations come at the end of the review/);
	assert.equal(byClass(view, 'fdr-rec').length, 0);
});

test('conversation cards render the finished review and each do-now recommendation', () => {
	const doc = fakeDocument();
	const reportMessage = { id: `founder-report-${Date.now()}`, role: 'assistant', kind: 'founder-report', text: 'done' };
	const card = renderFounderReportCard(finished, reportMessage, { onOpenReport() {} }, doc);
	assert.match(text(card), /Founder review complete/);
	assert.match(text(card), /3 to do now/);
	const recCard = renderFounderRecCard(finished, { id: `founder-rec-${Date.now()}-R1`, kind: 'founder-rec', text: '**R1** · Publish' }, { onOpenReport() {} }, doc);
	assert.match(text(recCard), /Publish a pricing page/);
	assert.equal(isQaConversationMessage(reportMessage, finished), true);
	assert.match(text(renderQaMessageBody(reportMessage, finished, {}, { doc, markdown: value => value })), /Founder review complete/);
});

test('links in competitor research never become script URLs', () => {
	const unsafe = structuredClone(finished);
	unsafe.founder.report.competitors = [{ id: 'C1', name: 'Bad', url: 'javascript:alert(1)', positioning: 'x', strengths: [] }];
	unsafe.founder.market.competitors = unsafe.founder.report.competitors;
	const view = renderFounderReview(unsafe, {}, fakeDocument());
	assert.ok(findAll(view, item => item.tagName === 'A').every(anchor => !/^javascript:/i.test(anchor.href ?? '')));
});
