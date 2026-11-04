import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSqaContext } from './sqaPrompt.js';
import { createSqaState } from './sqaService.js';
import { SQA_BROWSER_WORKFLOW_CHECKPOINT, SQA_INPUT_TOKEN_BUDGET } from './sqaBrowserBudget.js';

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
	session.activities = [
		{ toolName: 'browser_open', status: 'done' },
		{ toolName: 'browser_snapshot', status: 'done' }
	];
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
	assert.match(context, /Browser tool budget: 2\/120 used; 118 remaining/);
	assert.match(context, /browser_sqa_smoke once with action=accessibility/i);
	assert.match(context, /browser_sqa_smoke once with action=responsive/i);
	assert.match(context, /browser_sqa_smoke action=navigation/i);
	assert.match(context, /action=form_validation/i);
	assert.match(context, /close_after_safety_limit=true/i);
	assert.ok(context.includes(`Input-token safety budget: 0/${SQA_INPUT_TOKEN_BUDGET} used`));
	assert.ok(context.includes(`Workflow checkpoint: 2/${SQA_BROWSER_WORKFLOW_CHECKPOINT} browser actions`));
	assert.match(context, /two verified locator strategies/);
});
