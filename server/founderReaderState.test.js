import test from 'node:test';
import assert from 'node:assert/strict';
import { createFounderReadingStore, founderReadingKey, founderViewSignature } from '../public/founderReaderState.js';

const session = { id: 'review', ownerUserId: 'owner', founder: { finalizedAt: 'published' } };
function storage() { let value; return { getItem() { return value; }, setItem(key, next) { value = next; } }; }

test('reading preferences survive reload and isolate owner, run, surface and publication', () => {
	const memory = storage(), store = createFounderReadingStore(memory), key = founderReadingKey(session, 'report-view');
	store.put(key, { scrollTop: 420, section: 'risks', disclosures: { 'criteria-rec-0': true, 'assumptions-3': false } });
	assert.deepEqual(createFounderReadingStore(memory).get(key), { scrollTop: 420, section: 'risks', disclosures: { 'criteria-rec-0': true, 'assumptions-3': false } });
	for (const other of [{ ...session, id: 'different' }, { ...session, ownerUserId: 'different' }, { ...session, founder: { finalizedAt: 'different' } }]) assert.equal(store.get(founderReadingKey(other, 'report-view')).scrollTop, 0);
	assert.equal(store.get(founderReadingKey(session, 'founder-view')).scrollTop, 0);
});

test('reading preferences are bounded and usable when storage is blocked or corrupt', () => {
	const memory = storage(), store = createFounderReadingStore(memory);
	for (let i = 0; i < 20; i++) store.put(String(i), { scrollTop: i, disclosures: {}, section: 'summary' });
	assert.equal(JSON.parse(memory.getItem()).entries.length, 12); assert.equal(store.get('0').scrollTop, 0); assert.equal(store.get('19').scrollTop, 19);
	const blocked = createFounderReadingStore({ getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Blocked'); } });
	blocked.put('safe', { scrollTop: 12, disclosures: {}, section: 'summary' }); assert.equal(blocked.get('safe').scrollTop, 12);
	assert.equal(createFounderReadingStore({ getItem() { return 'invalid'; } }).get('safe').scrollTop, 0);
});

test('equivalent refreshed report objects share a render signature without changing their data', () => {
	const input = { report: { title: 'Fixture', fields: ['First', 'Second'] }, scope: { name: 'Scope' } }, before = structuredClone(input);
	assert.equal(founderViewSignature(input), founderViewSignature({ scope: { name: 'Scope' }, report: { fields: ['First', 'Second'], title: 'Fixture' } }));
	assert.notEqual(founderViewSignature(input), founderViewSignature({ ...input, report: { ...input.report, fields: ['Second', 'First'] } }));
	assert.deepEqual(input, before);
});

test('restored preferences discard report content, invalid positions and prototype keys', () => {
	const memory = storage();
	memory.setItem('ignored', '{"version":1,"entries":[{"key":"safe","scrollTop":-10,"section":9,"report":"private report text","selections":["rec-0"],"disclosures":{"criteria-rec-0":true,"unexpected":"private text","__proto__":true,"constructor":true}}]}');
	const store = createFounderReadingStore(memory);
	assert.deepEqual(store.get('safe'), { scrollTop: 0, section: '', disclosures: { 'criteria-rec-0': true } });
	store.put('safe', store.get('safe'));
	assert.doesNotMatch(memory.getItem(), /private|selections|__proto__|constructor/);
	assert.equal({}.polluted, undefined);
});
