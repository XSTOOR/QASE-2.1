import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSqaContext } from './sqaPrompt.js';
import { createSqaState } from './sqaService.js';

test('SQA context makes progress explicit and orders technical smoke checks before documentary assurance', () => {
	const session = {
		id: '123e4567-e89b-42d3-a456-426614174101',
		mode: 'sqa',
		targetUrl: 'https://example.test/',
		sqa: createSqaState({
			authorizationConfirmed: true,
			profiles: ['core'],
			attributes: ['web_application', 'user_interface'],
			target: { name: 'Example', release: '1', environment: 'test' }
		}, () => Date.parse('2026-08-17T00:00:00.000Z'))
	};
	session.sqa.observations.push({
		controlId: 'SQA-GOV-001', status: 'blocked', rationale: 'No reviewed risk register.', evidence: []
	});
	const context = buildSqaContext(session, 'https://example.test/login');

	assert.match(context, /Recorded controls: 1\/\d+\./);
	assert.match(context, /record_sqa_blockers/);
	assert.match(context, /authentication prevents representative workflows/);
	assert.match(context, /SQA-WEB-001 \[PENDING/);
	assert.match(context, /SQA-QUA-001 \[PENDING/);
	assert.match(context, /SQA-GOV-001 \[recorded=blocked/);
	assert.ok(context.indexOf('- SQA-WEB-001 [') < context.indexOf('- SQA-GOV-001 ['));
	assert.ok(context.indexOf('- SQA-QUA-001 [') < context.indexOf('# Reviewer-only assurance controls'));
	assert.match(context, /controls batch of up to 12/);
});
