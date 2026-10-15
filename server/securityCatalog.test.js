import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	QA_TEST_CATALOG_VERSION,
	QA_STANDARD_TESTS,
	QA_SECURITY_TEST_IDS,
	publicQaTestCatalog
} from './qaTestCatalog.js';
import {
	validateQaSelectedTests,
	validateSecurityAuthorization,
	selectionRequiresSecurityAuthorization
} from './appQaSelection.js';

test('the catalog exposes a Security testing category of 6 checks with availability', () => {
	assert.equal(QA_TEST_CATALOG_VERSION, '2026.10.1');
	assert.deepEqual(QA_SECURITY_TEST_IDS, [
		'security_authentication',
		'security_authorization',
		'security_input_validation',
		'security_sql_injection',
		'security_mitm',
		'security_dos'
	]);
	assert.equal(QA_STANDARD_TESTS.length, 14);
	const standard = QA_STANDARD_TESTS.filter(test => test.category === 'standard');
	assert.equal(standard.length, 8);
	assert.ok(standard.every(test => test.availability.available === true));
});

test('unavailable security checks carry honest, specific reasons', () => {
	const mitm = QA_STANDARD_TESTS.find(test => test.id === 'security_mitm');
	const dos = QA_STANDARD_TESTS.find(test => test.id === 'security_dos');
	assert.equal(mitm.availability.available, false);
	assert.equal(mitm.availability.reason, 'Not implemented — requires an agreed, configured MITM scenario.');
	assert.equal(dos.availability.available, false);
	assert.equal(dos.availability.reason, 'Not implemented — requires an agreed, configured DoS scenario.');
});

test('public catalog payload includes category and availability', () => {
	const payload = publicQaTestCatalog();
	assert.equal(payload.catalogVersion, QA_TEST_CATALOG_VERSION);
	assert.equal(payload.tests.length, 14);
	for (const test of payload.tests) {
		assert.ok(['standard', 'security'].includes(test.category));
		assert.ok(typeof test.availability.available === 'boolean');
		if (test.availability.available === false) {
			assert.ok(test.availability.reason.length > 10);
		}
	}
	const mitm = payload.tests.find(test => test.id === 'security_mitm');
	assert.equal(mitm.category, 'security');
	assert.equal(mitm.availability.available, false);
	assert.match(mitm.availability.reason, /agreed, configured MITM scenario/);
});

test('available security ids validate like standard ids', () => {
	assert.deepEqual(
		validateQaSelectedTests(['navigation', 'security_authentication']),
		['navigation', 'security_authentication']
	);
	assert.deepEqual(
		validateQaSelectedTests(['security_authentication', 'security_authorization', 'security_input_validation', 'security_sql_injection']),
		['security_authentication', 'security_authorization', 'security_input_validation', 'security_sql_injection']
	);
});

test('unavailable security ids are rejected regardless of anything else', () => {
	assert.throws(() => validateQaSelectedTests(['security_mitm']), /Unavailable test: .*MITM/);
	assert.throws(() => validateQaSelectedTests(['security_dos']), /Unavailable test: .*DoS/);
	assert.throws(
		() => validateQaSelectedTests(['navigation', 'security_mitm']),
		/Unavailable test: .*MITM/
	);
});

test('security selection requires explicit authorization', () => {
	assert.equal(selectionRequiresSecurityAuthorization(['navigation']), false);
	assert.equal(selectionRequiresSecurityAuthorization(undefined), false);
	assert.equal(selectionRequiresSecurityAuthorization(['security_authentication']), true);

	// Missing / unconfirmed / malformed authorization → typed error.
	assert.throws(
		() => validateSecurityAuthorization(undefined, ['security_authentication']),
		/requires explicit authorization/
	);
	assert.throws(
		() => validateSecurityAuthorization({ confirmed: false }, ['security_authentication']),
		/requires explicit authorization/
	);
	assert.throws(
		() => validateSecurityAuthorization('yes', ['security_authentication']),
		/must be an object/
	);
	assert.throws(
		() => validateSecurityAuthorization({ confirmed: 1 }, ['security_authentication']),
		/confirmed must be a boolean/
	);

	// Confirmed → normalized payload.
	assert.deepEqual(
		validateSecurityAuthorization({ confirmed: true }, ['security_authentication']),
		{ confirmed: true }
	);
	assert.deepEqual(
		validateSecurityAuthorization({ confirmed: true, notes: '  isolated staging env  ' }, ['security_authentication']),
		{ confirmed: true, notes: 'isolated staging env' }
	);
});

test('authorization without security selection is inert but validated', () => {
	// Absent → undefined.
	assert.equal(validateSecurityAuthorization(undefined, ['navigation']), undefined);
	// Present and well-formed → kept (inert for standard runs).
	assert.deepEqual(
		validateSecurityAuthorization({ confirmed: false }, ['navigation']),
		{ confirmed: false }
	);
	// Present but malformed → still rejected.
	assert.throws(
		() => validateSecurityAuthorization({ confirmed: true, notes: 42 }, ['navigation']),
		/notes must be a string/
	);
});
