import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	QA_TEST_CATALOG_VERSION,
	QA_STANDARD_TESTS,
	publicQaTestCatalog
} from './qaTestCatalog.js';
import { validateQaSelectedTests } from './appQaSelection.js';

const allIds = () => QA_STANDARD_TESTS.map(test => test.id);

test('the standard QA test catalog is a bounded, well-formed, versioned list', () => {
	assert.match(QA_TEST_CATALOG_VERSION, /^\d{4}\.\d{2}\.\d+$/);
	assert.ok(QA_STANDARD_TESTS.length >= 6, 'catalog should list the standard QA test areas');
	const seen = new Set();
	for (const entry of QA_STANDARD_TESTS) {
		assert.ok(entry.id && typeof entry.id === 'string', 'each test has an id');
		assert.ok(/^[a-z0-9_]+$/.test(entry.id), `test id is a stable slug: ${entry.id}`);
		assert.ok(!seen.has(entry.id), `test id is unique: ${entry.id}`);
		seen.add(entry.id);
		assert.ok(entry.title && typeof entry.title === 'string', `${entry.id} has a title`);
		assert.ok(entry.description && typeof entry.description === 'string', `${entry.id} has a description`);
		assert.ok(entry.focus && typeof entry.focus === 'string' && entry.focus.length > 20,
			`${entry.id} carries plan guidance`);
	}
});

test('the public QA catalog payload exposes exactly what the launcher needs', () => {
	const payload = publicQaTestCatalog();
	assert.equal(payload.catalogVersion, QA_TEST_CATALOG_VERSION);
	assert.equal(payload.tests.length, QA_STANDARD_TESTS.length);
	for (const test of payload.tests) {
		// category + availability joined the launcher contract with the
		// Security testing feature; nothing else may leak.
		assert.deepEqual(Object.keys(test).sort(), ['availability', 'category', 'description', 'focus', 'id', 'title']);
	}
});

test('selected test ids validate against the catalog', () => {
	// undefined (legacy clients) is allowed and means full coverage
	assert.equal(validateQaSelectedTests(undefined), undefined);
	// a valid subset round-trips
	const subset = [allIds()[0], allIds()[2]];
	assert.deepEqual(validateQaSelectedTests(subset), subset);
	// all selectable tests is fine too (unavailable ones are not selectable)
	const selectable = QA_STANDARD_TESTS.filter(test => test.availability.available).map(test => test.id);
	assert.deepEqual(validateQaSelectedTests(selectable), selectable);
});

test('invalid selected test ids are rejected with typed errors', () => {
	assert.throws(() => validateQaSelectedTests('navigation'), TypeError);
	assert.throws(() => validateQaSelectedTests([allIds()[0], 'made_up_test']), TypeError);
	assert.throws(() => validateQaSelectedTests([allIds()[0], allIds()[0]]), TypeError);
	assert.throws(() => validateQaSelectedTests(Array.from({ length: 33 }, () => allIds()[0])),
		TypeError);
	assert.throws(() => validateQaSelectedTests([]), TypeError);
});
