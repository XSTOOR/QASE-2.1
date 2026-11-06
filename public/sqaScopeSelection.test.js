import assert from 'node:assert/strict';
import test from 'node:test';
import { SQA_CATALOG, SQA_TECHNICAL_CONTROL_IDS } from '../server/sqaCatalog.js';
import {
	SQA_REQUIRED_BROWSER_ATTRIBUTES,
	describeSqaScopeSelection
} from './sqaScopeSelection.js';

test('recommended URL review always previews the web and UI scope with all six browser controls', () => {
	const preview = describeSqaScopeSelection(SQA_CATALOG, { profiles: ['core'], attributes: [] });
	assert.deepEqual(preview.attributes, SQA_REQUIRED_BROWSER_ATTRIBUTES);
	assert.deepEqual(preview.browserControlIds, SQA_TECHNICAL_CONTROL_IDS);
	assert.equal(preview.applicableControlIds.length, 30);
	assert.equal(preview.expanded, false);
	assert.equal(preview.requiresConfirmation, false);
	assert.deepEqual(preview.additionalControlIds, []);
	assert.match(preview.text, /^30 controls selected.*Recommended core.*6 browser checks$/);
	assert.match(preview.reasons[1], /because this assessment tests a web URL and user interface/);
});

test('additional profiles and characteristics update the preview without duplicating required scope', () => {
	const preview = describeSqaScopeSelection(SQA_CATALOG, {
		profiles: ['core', 'medical', 'medical'],
		attributes: ['web_application', 'handles_personal_data', 'handles_personal_data']
	});
	assert.deepEqual(preview.profiles, ['core', 'medical']);
	assert.deepEqual(preview.attributes, ['web_application', 'user_interface', 'handles_personal_data']);
	assert.equal(preview.browserControlIds.length, 6);
	assert.equal(preview.expanded, true);
	assert.equal(preview.requiresRationale, true);
	assert.equal(preview.requiresConfirmation, true);
	assert.ok(preview.additionalControlIds.length > 0);
	assert.match(preview.text, /recommended \+ \d+ additional/);
	assert.match(preview.warning, /Explain why.*confirm the broader review/);
	assert.match(preview.reasons.at(-2), /1 additional standards profile selected/);
	assert.match(preview.reasons.at(-1), /1 additional product characteristic selected/);
});

test('malformed catalog entries do not enter the client preview', () => {
	const preview = describeSqaScopeSelection({ controls: [{ id: 'BROKEN' }, null] });
	assert.deepEqual(preview.applicableControlIds, []);
	assert.equal(preview.expanded, false);
	assert.match(preview.text, /^0 controls selected/);
});
