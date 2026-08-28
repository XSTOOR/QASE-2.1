import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFounderContext } from './founderPrompt.js';
import { createFounderState, recordFounderPublicOnlyDecision } from './founderService.js';

test('Founder prompt requires truthful full-surface workflow coverage and bounded strategy', () => {
	const session = {
		id: 'founder-prompt', mode: 'founder', targetUrl: 'https://example.test/', secretNames: [],
		founder: createFounderState({ authorizationConfirmed: true, target: { name: 'Example', url: 'https://example.test/' } })
	};
	const prompt = buildFounderContext(session, 'https://example.test/');
	assert.match(prompt, /route\/surface inventory/i);
	assert.match(prompt, /representative path/i);
	assert.match(prompt, /public and authenticated surfaces/i);
	assert.match(prompt, /never claim you reviewed the complete project/i);
	assert.match(prompt, /Never invent users.*revenue/is);
	assert.match(prompt, /dedicated monetization\/pricing plan/i);
	assert.match(prompt, /do not browse unrelated competitor sites/i);
	assert.match(prompt, /host has already published the canonical plan/i);
	assert.match(prompt, /observations array.*one atomic call/is);
	assert.match(prompt, /different origin.*outside this run's declared scope/is);
	assert.match(prompt, /do not ask the user to change an\s+operator allowlist/i);
	assert.match(prompt, /Never pause merely\s+because these optional fields were not supplied/i);
	assert.match(prompt, /Before every ask_question, call update_todo first/i);
	assert.match(prompt, /finish_founder_review/);
});

test('Founder prompt treats a public-only choice as final for the review', () => {
	const session = {
		id: 'founder-public', mode: 'founder', targetUrl: 'https://example.test/', secretNames: [],
		founder: createFounderState({ authorizationConfirmed: true, target: { name: 'Example', url: 'https://example.test/' } })
	};
	recordFounderPublicOnlyDecision(session);
	const prompt = buildFounderContext(session, 'https://example.test/login');
	assert.match(prompt, /user chose a public-only review/i);
	assert.match(prompt, /Do not attempt login and do not ask for credentials again/i);
	assert.match(prompt, /mark authenticated surfaces not\s+observed and continue every reachable workflow/i);
});
