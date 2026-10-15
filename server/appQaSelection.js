/**
 * Validation for the standard-QA test selection and the security testing
 * authorization carried on a new run.
 *
 * The catalog in `qaTestCatalog.js` is the only source of valid ids. Selection
 * is optional end to end: a request without `selectedTests` (older clients,
 * the API) means the historical full-coverage run, unchanged.
 *
 * Security-category checks are intrusive by nature: they may only run when the
 * requester explicitly confirms the target is an authorized, isolated test
 * environment (`securityAuthorization.confirmed`). Unavailable checks
 * (availability.available === false) are never valid selections — no scenario
 * for them has been agreed or configured, and none is invented here.
 */
import { QA_STANDARD_TESTS, QA_SECURITY_TEST_IDS } from './qaTestCatalog.js';

const MAX_SELECTED_TESTS = 32;

const KNOWN_TEST_IDS = new Set(QA_STANDARD_TESTS.map(test => test.id));
const SECURITY_TEST_IDS = new Set(QA_SECURITY_TEST_IDS);
const UNAVAILABLE_TESTS = new Map(
	QA_STANDARD_TESTS
		.filter(test => test.availability?.available === false)
		.map(test => [test.id, test.availability.reason])
);

/**
 * Returns the validated selection (a new array of known ids) or `undefined`
 * when the caller sent nothing — which the agent treats as full coverage.
 * @throws {TypeError} for unknown, duplicate, empty, oversized, or unavailable selections.
 */
export function validateQaSelectedTests(selectedTests) {
	if (selectedTests === undefined || selectedTests === null) return undefined;
	if (!Array.isArray(selectedTests)) {
		throw new TypeError('Selected tests must be an array of standard test ids.');
	}
	if (selectedTests.length === 0) {
		throw new TypeError('Select at least one standard test.');
	}
	if (selectedTests.length > MAX_SELECTED_TESTS) {
		throw new TypeError(`Select no more than ${MAX_SELECTED_TESTS} standard tests.`);
	}
	const seen = new Set();
	for (const id of selectedTests) {
		if (typeof id !== 'string' || !KNOWN_TEST_IDS.has(id)) {
			throw new TypeError(`Unknown standard test: ${String(id)}.`);
		}
		const unavailableReason = UNAVAILABLE_TESTS.get(id);
		if (unavailableReason !== undefined) {
			throw new TypeError(`Unavailable test: ${unavailableReason}`);
		}
		if (seen.has(id)) {
			throw new TypeError(`Duplicate standard test: ${id}.`);
		}
		seen.add(id);
	}
	return [...selectedTests];
}

/**
 * True when the validated selection includes at least one security-category
 * check — those require explicit authorization before a run may start.
 */
export function selectionRequiresSecurityAuthorization(selectedTests) {
	if (!Array.isArray(selectedTests)) return false;
	return selectedTests.some(id => SECURITY_TEST_IDS.has(id));
}

const SECURITY_AUTHORIZATION_NOTES_LIMIT = 2000;

/**
 * Validates the security testing authorization payload. Returns a normalized
 * `{ confirmed, notes }` or `undefined` when the caller sent nothing.
 *
 * @param {unknown} securityAuthorization raw request body field.
 * @param {string[]} selectedTests validated selection (known ids only).
 * @throws {TypeError} when a security check is selected without confirmation,
 *   or the payload itself is malformed.
 */
export function validateSecurityAuthorization(securityAuthorization, selectedTests) {
	const requires = selectionRequiresSecurityAuthorization(selectedTests);
	if (securityAuthorization === undefined || securityAuthorization === null) {
		if (requires) {
			throw new TypeError('Security testing requires explicit authorization: confirm the target is an explicitly authorized, isolated test environment.');
		}
		return undefined;
	}
	if (typeof securityAuthorization !== 'object' || Array.isArray(securityAuthorization)) {
		throw new TypeError('Security authorization must be an object with a confirmed flag.');
	}
	const { confirmed } = securityAuthorization;
	let { notes } = securityAuthorization;
	if (typeof confirmed !== 'boolean') {
		throw new TypeError('Security authorization confirmed must be a boolean.');
	}
	if (notes !== undefined && notes !== null) {
		if (typeof notes !== 'string') {
			throw new TypeError('Security authorization notes must be a string.');
		}
		notes = notes.trim().slice(0, SECURITY_AUTHORIZATION_NOTES_LIMIT) || undefined;
	} else {
		notes = undefined;
	}
	if (requires && confirmed !== true) {
		throw new TypeError('Security testing requires explicit authorization: confirm the target is an explicitly authorized, isolated test environment.');
	}
	return notes === undefined ? { confirmed } : { confirmed, notes };
}
