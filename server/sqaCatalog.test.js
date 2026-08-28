import assert from 'node:assert/strict';
import test from 'node:test';
import {
	SQA_CATALOG,
	SQA_CATALOG_VERSION,
	SQA_NO_CERTIFICATION_DISCLAIMER,
	SQA_TECHNICAL_CONTROL_IDS,
	getSqaControl,
	resolveSqaScope,
	validateSqaCatalog
} from './sqaCatalog.js';

test('catalog is versioned, immutable, internally valid, and mapped to primary sources', () => {
	assert.equal(validateSqaCatalog(SQA_CATALOG), SQA_CATALOG);
	assert.equal(SQA_CATALOG.catalogVersion, SQA_CATALOG_VERSION);
	assert.equal(SQA_CATALOG.schemaVersion, 1);
	assert.equal(Object.isFrozen(SQA_CATALOG), true);
	assert.equal(Object.isFrozen(SQA_CATALOG.controls[0]), true);
	assert.ok(SQA_CATALOG.controls.length >= 40);
	assert.ok(Object.keys(SQA_CATALOG.sources).length >= 20);
	assert.match(SQA_NO_CERTIFICATION_DISCLAIMER, /not legal advice.*certification/i);

	const ids = SQA_CATALOG.controls.map(control => control.id);
	assert.equal(new Set(ids).size, ids.length);
	for (const control of SQA_CATALOG.controls) {
		assert.ok(control.evidenceRequirements.length > 0);
		assert.ok(control.sources.length > 0);
		assert.equal(typeof control.mandatory, 'boolean');
		for (const sourceId of control.sources) {
			assert.match(SQA_CATALOG.sources[sourceId].url, /^https:\/\//);
		}
	}
});

test('scope resolution always includes core and applies conditional controls deterministically', () => {
	const basic = resolveSqaScope();
	assert.deepEqual(basic.profiles, ['core']);
	assert.equal(basic.attributes.length, 0);
	assert.equal(basic.applicableControls.some(control => control.id === 'SQA-QUA-004'), false);
	assert.equal(basic.excludedControls.some(control => control.controlId === 'SQA-QUA-004'), true);

	const web = resolveSqaScope({
		profiles: ['core', 'core'],
		attributes: ['web_application', 'handles_personal_data', 'web_application']
	});
	assert.deepEqual(web.profiles, ['core']);
	assert.deepEqual(web.attributes, ['web_application', 'handles_personal_data']);
	assert.equal(web.applicableControls.some(control => control.id === 'SQA-QUA-004'), true);
	assert.equal(web.applicableControls.some(control => control.id === 'SQA-PRI-001'), true);
	assert.equal(web.applicableControls.some(control => control.id === 'SQA-QUA-007'), false);
	assert.equal(web.applicableControls.some(control => control.id === 'SQA-AI-001'), false);
});

test('sector profiles add only their explicit readiness controls on top of core', () => {
	const medical = resolveSqaScope({ profiles: ['medical'] });
	assert.deepEqual(medical.profiles, ['core', 'medical']);
	assert.deepEqual(
		medical.applicableControls.filter(control => control.id.startsWith('SQA-MED-')).map(control => control.id),
		['SQA-MED-001', 'SQA-MED-002', 'SQA-MED-003']
	);
	assert.equal(medical.applicableControls.some(control => control.id.startsWith('SQA-AVN-')), false);

	const combined = resolveSqaScope({ profiles: ['payment', 'functional_safety', 'aviation'] });
	assert.deepEqual(combined.profiles, ['core', 'payment', 'functional_safety', 'aviation']);
	assert.equal(combined.applicableControls.filter(control => control.id.startsWith('SQA-PCI-')).length, 3);
	assert.equal(combined.applicableControls.filter(control => control.id.startsWith('SQA-FSA-')).length, 3);
	assert.equal(combined.applicableControls.filter(control => control.id.startsWith('SQA-AVN-')).length, 3);
});

test('unknown scope values and malformed catalog mappings fail closed', () => {
	assert.throws(() => resolveSqaScope({ profiles: ['imaginary'] }), /Unknown profile/);
	assert.throws(() => resolveSqaScope({ attributes: ['typo_attribute'] }), /Unknown attribute/);
	const broken = structuredClone(SQA_CATALOG);
	broken.controls[0].sources = ['UNKNOWN_STANDARD'];
	assert.throws(() => validateSqaCatalog(broken), /unknown source/);
	const duplicate = structuredClone(SQA_CATALOG);
	duplicate.controls[1].id = duplicate.controls[0].id;
	assert.throws(() => validateSqaCatalog(duplicate), /Duplicate SQA control id/);
});

test('stable lookup returns controls without creating mutable copies', () => {
	const control = getSqaControl('SQA-TRC-001');
	assert.equal(control.title, 'Maintain bidirectional requirements traceability');
	assert.equal(Object.isFrozen(control), true);
	assert.equal(getSqaControl('SQA-NOT-999'), undefined);
});

test('browser-verifiable evidence contracts are achievable without weakening reviewer boundaries', () => {
	const traceEvidence = getSqaControl('SQA-TRC-002').evidenceRequirements;
	assert.deepEqual(traceEvidence.map(item => item.type), ['test_result']);
	assert.equal(getSqaControl('SQA-QUA-002').automationLevel, 'hybrid');
	assert.deepEqual(getSqaControl('SQA-QUA-004').evidenceRequirements.map(item => item.type), ['wcag_report']);

	// Approval and regulated-scope evidence must not be producible from a browser
	// activity merely because an adjacent technical check is agent-compatible.
	assert.deepEqual(
		getSqaControl('SQA-CHG-001').evidenceRequirements.map(item => item.type),
		['configuration_record', 'approval_record']
	);
	assert.deepEqual(
		getSqaControl('SQA-PCI-002').evidenceRequirements.map(item => item.type),
		['security_report', 'audit_record']
	);
});

test('technical web layer is a bounded six-control smoke sample, not a compliance claim', () => {
	assert.equal(SQA_CATALOG_VERSION, '2026.08.2');
	assert.equal(SQA_TECHNICAL_CONTROL_IDS.length, 6);
	const web = resolveSqaScope({ attributes: ['web_application'] });
	const technical = web.applicableControls.filter(control => SQA_TECHNICAL_CONTROL_IDS.includes(control.id));
	assert.deepEqual(technical.map(control => control.id), SQA_TECHNICAL_CONTROL_IDS);
	for (const control of technical) {
		assert.match(`${control.title} ${control.objective}`, /smoke|sample/i);
		assert.match(control.objective, /does not|not a WCAG|not establish/i);
		assert.equal(control.automationLevel, 'agent_assisted');
		assert.deepEqual(control.evidenceRequirements.map(item => item.type), ['test_result']);
		assert.equal(control.applicability.profiles.includes('core'), true);
		assert.equal(control.applicability.attributes.every(attribute => ['web_application', 'user_interface'].includes(attribute)), true);
		assert.equal(control.sources.every(source => ['ISO_25010', 'ISO_29119', 'WCAG_22'].includes(source)), true);
	}
	const nonWeb = resolveSqaScope();
	assert.equal(nonWeb.applicableControls.some(control => SQA_TECHNICAL_CONTROL_IDS.includes(control.id)), false);
});
