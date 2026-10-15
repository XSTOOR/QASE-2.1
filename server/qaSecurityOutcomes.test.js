import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQaTools } from './qaTools.js';

function securitySession(overrides = {}) {
	return {
		id: 'sec-run',
		mode: 'qa',
		targetUrl: 'https://fixture.test',
		selectedTests: ['security_authentication', 'security_sql_injection'],
		messages: [], activities: [], todos: [], findings: [], secretNames: [],
		...overrides
	};
}

function completedRun(session) {
	// Minimal completed state that passes the finalizer's completion gates.
	return {
		...session,
		todos: [{ text: 'Plan item', status: 'completed' }],
		activities: [{ toolName: 'browser_snapshot', status: 'done' }]
	};
}

async function finish(session, input) {
	const store = { async commit() {}, async addMessage() {}, publish() {} };
	const [, finishReport] = createQaTools(session, store);
	const result = await finishReport.run(input);
	// The published report is written onto the session.
	return { result, report: session.report };
}

const baseInput = {
	verdict: 'pass',
	summary: 'Completed the run.',
	covered: ['authentication flows']
};

test('security runs require an explicit outcome for every selected check', async () => {
	const session = completedRun(securitySession());
	const { result: missing } = await finish(session, baseInput);
	assert.equal(missing.success, false);
	assert.match(missing.error, /security_outcomes must include every selected security check/);
	assert.match(missing.error, /security_authentication/);

	const { result: complete, report } = await finish(session, {
		...baseInput,
		security_outcomes: [
			{ check: 'security_authentication', outcome: 'pass', reason: 'Invalid login rejected generically; logout invalidated the session (verified via redirect).' },
			{ check: 'security_sql_injection', outcome: 'not_tested', reason: 'No database error text or differential response observed; absence of evidence is not proof of safety.' }
		]
	});
	assert.equal(complete.success, true);
	assert.deepEqual(report.securityOutcomes, [
		{ check: 'security_authentication', outcome: 'pass', reason: 'Invalid login rejected generically; logout invalidated the session (verified via redirect).' },
		{ check: 'security_sql_injection', outcome: 'not_tested', reason: 'No database error text or differential response observed; absence of evidence is not proof of safety.' }
	]);
});

test('not_tested requires a reason; unavailable checks can only be not_tested', async () => {
	const session = completedRun(securitySession({
		selectedTests: ['security_mitm', 'security_dos', 'security_authentication']
	}));
	const { result: noReason } = await finish(session, {
		...baseInput,
		security_outcomes: [
			{ check: 'security_authentication', outcome: 'not_tested' }
		]
	});
	assert.equal(noReason.success, false);
	assert.match(noReason.error, /security_authentication is not_tested and requires a reason/);

	const { result: mitmAsFail } = await finish(session, {
		...baseInput,
		security_outcomes: [
			{ check: 'security_authentication', outcome: 'pass', reason: 'Observed secure behavior.' },
			{ check: 'security_mitm', outcome: 'fail' },
			{ check: 'security_dos', outcome: 'not_tested', reason: 'Not implemented — requires an agreed, configured DoS scenario.' }
		]
	});
	assert.equal(mitmAsFail.success, false);
	assert.match(mitmAsFail.error, /security_mitm is not implemented and can only be not_tested/);

	const { result: honest, report: honestReport } = await finish(session, {
		...baseInput,
		security_outcomes: [
			{ check: 'security_authentication', outcome: 'pass', reason: 'Observed secure behavior.' },
			{ check: 'security_mitm', outcome: 'not_tested', reason: 'Not implemented — requires an agreed, configured MITM scenario.' },
			{ check: 'security_dos', outcome: 'not_tested', reason: 'Not implemented — requires an agreed, configured DoS scenario.' }
		]
	});
	assert.equal(honest.success, true);
	assert.equal(honestReport.securityOutcomes.filter(entry => entry.outcome === 'not_tested').length, 2);
});

test('non-security runs are unchanged — no security_outcomes required', async () => {
	const session = completedRun(securitySession({ selectedTests: ['navigation'] }));
	const { result: plain, report: plainReport } = await finish(session, baseInput);
	assert.equal(plain.success, true);
	assert.equal(plainReport.securityOutcomes, undefined);

	const { result: legacy, report: legacyReport } = await finish(completedRun(securitySession({ selectedTests: undefined })), baseInput);
	assert.equal(legacy.success, true);
	assert.equal(legacyReport.securityOutcomes, undefined);
});

test('unknown and duplicated checks are rejected', async () => {
	const session = completedRun(securitySession());
	const { result: unknown } = await finish(session, {
		...baseInput,
		security_outcomes: [{ check: 'navigation', outcome: 'pass' }]
	});
	assert.equal(unknown.success, false);
	assert.match(unknown.error, /entries must reference this run/);

	const { result: duplicate } = await finish(session, {
		...baseInput,
		security_outcomes: [
			{ check: 'security_authentication', outcome: 'pass' },
			{ check: 'security_authentication', outcome: 'pass' }
		]
	});
	assert.equal(duplicate.success, false);
	assert.match(duplicate.error, /more than once/);
});
