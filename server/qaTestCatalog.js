/**
 * Standard QA test catalog — the checklist behind the test-selection screen on
 * the QA start dialog. Versioned like the SQA catalog so the launcher can
 * cache it; the server remains the source of truth.
 *
 * Each entry maps to an area the QA agent already covers in its test plan
 * (see prompt.js `buildQaContext`); the `focus` text is the per-test guidance
 * injected into the plan when that test is selected.
 *
 * `category` groups the launcher grid ("standard" | "security"); `availability`
 * marks checks that cannot run — unavailable ids are never valid selections.
 */
import { QA_TEST_CATALOG } from './qaTestCatalog.data.js';

export const QA_TEST_CATALOG_VERSION = QA_TEST_CATALOG.version;
export const QA_STANDARD_TESTS = Object.freeze(
	QA_TEST_CATALOG.tests.map(test => Object.freeze({ ...test }))
);

export const QA_SECURITY_TEST_IDS = Object.freeze(
	QA_STANDARD_TESTS.filter(test => test.category === 'security').map(test => test.id)
);

/**
 * Public payload for `GET /api/qa/catalog`. Deliberately minimal — no
 * internals, just what the launcher needs to render checkboxes (including
 * category grouping and unavailable-check reasons).
 */
export function publicQaTestCatalog() {
	return {
		catalogVersion: QA_TEST_CATALOG_VERSION,
		tests: QA_STANDARD_TESTS.map(test => ({
			id: test.id,
			title: test.title,
			description: test.description,
			focus: test.focus,
			category: test.category,
			availability: { ...test.availability }
		}))
	};
}
