// #17936 — SQA JEV integration: bounded, advisory, fail-open, fully traced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSqaJevVerifier } from './sqaJevVerifier.js';

function okFetch(answer) {
	return async (url, options) => {
		const body = JSON.parse(options.body);
		// record the request so tests can assert question shape
		okFetch.lastBody = body;
		return new Response(JSON.stringify({
			id: 'dec-1', model: 'jev-1.13',
			answers: { evidence_sufficiency: { type: 'choice', choice: answer } },
			usage: { input_tokens: 220, output_tokens: 8 }
		}), { headers: { 'content-type': 'application/json' } });
	};
}

function failingFetch() {
	return async () => ({ ok: false, status: 503, body: { cancel: async () => {} } });
}

const session = () => ({ id: 'sqa-run-1', mode: 'sqa' });

test('verifier is invoked for pass decisions and returns a challenge on insufficient evidence', async () => {
	const fetchImpl = okFetch('insufficient');
	const usage = [];
	const verifier = createSqaJevVerifier({ session: session(), settings: { apiKey: 'jev-test-key' }, onUsage: u => usage.push(u), fetchImpl });
	const result = await verifier.verify({ controlId: 'infra-001', status: 'pass', rationale: 'looks fine', evidence: [{ type: 'test_result', summary: 'page loaded' }] });
	assert.equal(result.challenge !== undefined, true);
	assert.match(result.challenge, /generic or insufficient/);
	// Token receipt flowed to the shared accounting service with the model.
	assert.equal(usage.length >= 1, true);
	assert.equal(usage[0].model, 'jev-1.13');
	// Question shape is a bounded choice with exactly two criteria.
	const q = okFetch.lastBody?.questions?.evidence_sufficiency;
	assert.equal(q.type, 'choice');
	assert.equal(Object.keys(q.criteria).length, 2);
});

test('verifier is advisory for the agent — sufficient evidence returns no challenge', async () => {
	const verifier = createSqaJevVerifier({ session: session(), settings: { apiKey: 'jev-test-key' }, onUsage: () => {}, fetchImpl: okFetch('sufficient') });
	const result = await verifier.verify({ controlId: 'a', status: 'pass', rationale: 'r', evidence: [{ type: 'test_result', summary: 'saw error banner for bad input' }] });
	assert.equal(result.challenge, null);
});

test('verifier skips non-pass statuses (only pass decisions carry mis-pass risk)', async () => {
	let called = 0;
	const verifier = createSqaJevVerifier({ session: session(), settings: { apiKey: 'jev-test-key' }, onUsage: () => {}, fetchImpl: async () => { called++; throw new Error('unreachable'); } });
	assert.equal(await verifier.verify({ controlId: 'a', status: 'fail' }), null);
	assert.equal(await verifier.verify({ controlId: 'a', status: 'blocked' }), null);
	assert.equal(called, 0);
});

test('verifier is bounded — stops after maxVerifications calls', async () => {
	let called = 0;
	const fetchImpl = async () => { called++; return (await okFetch('sufficient'))(); };
	const verifier = createSqaJevVerifier({ session: session(), settings: { apiKey: 'jev-test-key' }, onUsage: () => {}, fetchImpl, maxVerifications: 2 });
	await verifier.verify({ controlId: 'a', status: 'pass', rationale: 'r', evidence: [] });
	await verifier.verify({ controlId: 'b', status: 'pass', rationale: 'r', evidence: [] });
	const third = await verifier.verify({ controlId: 'c', status: 'pass', rationale: 'r', evidence: [] });
	assert.equal(third, null, 'budget exhausted → skipped');
	assert.equal(verifier.calls(), 2);
});

test('verifier fails OPEN on classifier outage — run never blocked', async () => {
	const verifier = createSqaJevVerifier({ session: session(), settings: { apiKey: 'jev-test-key' }, onUsage: () => {}, fetchImpl: failingFetch() });
	const result = await verifier.verify({ controlId: 'a', status: 'pass', rationale: 'r', evidence: [] });
	assert.equal(result, null, 'outage is a skip, not an error');
});

test('QASE_SQA_JEV=false disables the verifier entirely', async () => {
	process.env.QASE_SQA_JEV = 'false';
	try {
		const verifier = createSqaJevVerifier({ session: session(), settings: { apiKey: 'jev-test-key' }, onUsage: () => {}, fetchImpl: okFetch('insufficient') });
		assert.equal(verifier.enabled, false);
		assert.equal(await verifier.verify({ controlId: 'a', status: 'pass' }), null);
	} finally {
		delete process.env.QASE_SQA_JEV;
	}
});
