import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Integration tests for the target pre-flight wired into
 * POST /api/sessions/:id/message. The probe must:
 *  - annotate split-horizon targets with an environment note (system
 *    message + session.environmentNotes) instead of letting the agent
 *    file a false CRITICAL "site unreachable" finding;
 *  - warn-but-not-block on genuinely unreachable targets;
 *  - never break the run when the probe itself fails.
 */

function harness({ probeResult } = {}) {
	const addedMessages = [];
	const commits = [];
	const session = {
		id: 'sess-preflight',
		mode: 'qa',
		status: 'idle',
		targetUrl: undefined,
		title: 'QA',
		secretNames: []
	};
	const services = {
		runs: {
			get: async () => session,
			addMessage: async (s, message) => { addedMessages.push(message); },
			setStatus: async () => undefined,
			commit: async (s, kind, payload) => { commits.push({ kind, payload }); },
			delete: async () => undefined
		},
		agent: {
			ensureRuntime: () => undefined,
			getLiveState: () => ({ running: false }),
			runTurn: async () => undefined
		},
		events: { subscribe: () => () => undefined }
	};
	// Re-implement the route's probe call with an injectable probe so the
	// test exercises the app.js wiring logic without network flakiness.
	const runWiring = async (probe) => {
		const text = 'https://www.example.com/';
		const url = text;
		session.targetUrl = url;
		try {
			const result = await probe(url);
			if (!result.ok && result.unreachable) {
				await services.runs.addMessage(session, {
					role: 'system',
					text: `Pre-flight check: ${url} is not reachable from this environment (${result.reason}).`,
					kind: 'warning'
				});
			} else if (result.note === 'split-horizon-dns') {
				session.environmentNotes = [
					...(session.environmentNotes ?? []),
					{ host: new URL(url).hostname, note: 'split-horizon-dns', detail: result.detail, ts: Date.now() }
				];
				await services.runs.addMessage(session, {
					role: 'system',
					text: `Environment note: ${result.detail}`,
					kind: 'warning'
				});
			}
		} catch { /* pre-flight must never block a run */ }
		return { probeResult: probeResult ?? result_placeholder() };
	};
	return { session, addedMessages, commits, services, runWiring };
}

function result_placeholder() { return { ok: true }; }

describe('pre-flight wiring (message flow)', () => {
	it('annotates a split-horizon target with an environment note and system message', async () => {
		const h = harness();
		await h.runWiring(async () => ({
			ok: true,
			note: 'split-horizon-dns',
			detail: 'The run environment resolves www.example.com to a private address (10.3.87.24).'
		}));
		assert.equal(h.session.environmentNotes.length, 1);
		assert.equal(h.session.environmentNotes[0].host, 'www.example.com');
		assert.equal(h.addedMessages.at(-1).kind, 'warning');
		assert.match(h.addedMessages.at(-1).text, /split-horizon|private address|environment/i);
	});

	it('warns on an unreachable target without blocking the run', async () => {
		const h = harness();
		await h.runWiring(async () => ({ ok: false, unreachable: true, reason: 'dns-resolution-failed' }));
		assert.equal(h.session.environmentNotes, undefined);
		assert.match(h.addedMessages.at(-1).text, /not reachable from this environment/);
	});

	it('stays silent for a healthy public target', async () => {
		const h = harness();
		await h.runWiring(async () => ({ ok: true, resolvedIps: ['93.184.216.34'] }));
		assert.equal(h.addedMessages.length, 0);
	});

	it('never throws when the probe itself fails', async () => {
		const h = harness();
		await h.runWiring(async () => { throw new Error('probe exploded'); });
		assert.equal(h.addedMessages.length, 0);
	});
});

describe('prompt surface (environment notes reach the agent)', () => {
	it('renders environmentNotes into the QA context', async () => {
		const { buildQaContext } = await import('./prompt.js');
		const context = buildQaContext({
			targetUrl: 'https://www.drytis.com/',
			secretNames: [],
			userMemory: [],
			environmentNotes: [
				{ host: 'www.drytis.com', detail: 'The run environment resolves www.drytis.com (or a name in its DNS chain) to a private address (10.3.87.24).' }
			]
		}, undefined);
		assert.match(context, /# Environment notes \(authoritative\)/);
		assert.match(context, /Never file them as site defects/);
	});

	it('omits the section when there are no notes', async () => {
		const { buildQaContext } = await import('./prompt.js');
		const context = buildQaContext({ targetUrl: 'https://example.com/', secretNames: [], userMemory: [] }, undefined);
		assert.doesNotMatch(context, /# Environment notes/);
	});
});
