import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { prepareLegacySessions, readLegacySessions } from './legacyImport.js';

const RUN_ID = 'ec58f749-3329-4876-93c9-8a788f1539a1';
const SECOND_RUN_ID = 'aa29f8a1-7652-4fa5-bc4e-350ce0e76f03';

function fullSession(overrides = {}) {
	return {
		id: RUN_ID,
		title: 'Example run',
		createdAt: 1_900_000_000_001,
		updatedAt: 1_900_000_000_099,
		status: 'done',
		targetUrl: 'https://example.com/',
		messages: [
			{ id: 'message-2', ts: 22, role: 'agent', text: 'Second' },
			{ id: 'message-1', ts: 11, role: 'user', text: 'First', kind: 'answer' }
		],
		activities: [{
			id: 'tool-call-1', ts: 33, status: 'done', type: 'tool',
			toolName: 'browser_open', label: 'Opened', detail: 'example.com',
			input: { url: 'https://example.com/' }, summary: 'Complete'
		}],
		findings: [{
			id: 'finding-1', ts: 44, title: 'Broken action', severity: 'high',
			category: 'forms', url: 'https://example.com/', steps: ['Open', 'Submit'],
			expected: 'Saved', actual: 'Failed', evidence: 'HTTP 500'
		}],
		todos: [
			{ text: 'Second check', status: 'pending' },
			{ text: 'First check', status: 'completed' }
		],
		report: {
			ts: 55, verdict: 'pass_with_issues', summary: 'Mostly works',
			covered: ['Login'], notCovered: ['Billing'], recommendations: ['Fix forms'],
			targetUrl: 'https://example.com/', findings: 1,
			bySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 }
		},
		pendingQuestion: {
			toolCallId: 'ask-1', question: 'Continue?', summary: 'Decision',
			options: [{ label: 'Yes', description: 'Continue testing' }],
			allowCustom: true, customLabel: 'Other', placeholder: 'Answer', credentialLike: false
		},
		contextUsage: { percentage: 12.5, used: 1000, window: 8000 },
		secretNames: ['QA_PASSWORD'],
		...overrides
	};
}

function prepare(value, options) {
	return prepareLegacySessions(JSON.stringify(value), options);
}

test('preparation preserves supported aggregate values, IDs, timestamps, and source order', () => {
	const raw = JSON.stringify([fullSession()]);
	const result = prepareLegacySessions(raw);
	const session = result.sessions[0];

	assert.equal(result.source.sha256, createHash('sha256').update(raw).digest('hex'));
	assert.equal(result.source.bytes, Buffer.byteLength(raw));
	assert.equal(result.summary.dryRun, true);
	assert.equal(result.summary.inputSessions, 1);
	assert.equal(result.summary.preparedSessions, 1);
	assert.equal(session.id, RUN_ID);
	assert.equal(session.createdAt, 1_900_000_000_001);
	assert.equal(session.updatedAt, 1_900_000_000_099);
	assert.deepEqual(session.messages.map(message => message.id), ['message-2', 'message-1']);
	assert.deepEqual(session.todos.map(todo => todo.text), ['Second check', 'First check']);
	assert.equal(session.findings[0].ts, 44);
	assert.equal(session.report.ts, 55);
	assert.equal(session.pendingQuestion.question, 'Continue?');
	assert.deepEqual(session.contextUsage, { percentage: 12.5, used: 1000, window: 8000 });
});

test('missing arrays normalize, interrupted runs clear questions, thinking is removed, and secrets always clear', () => {
	const waiting = fullSession({
		status: 'awaiting_input',
		messages: [
			{ id: 'thinking-1', ts: 1, role: 'thinking', text: 'temporary reasoning' },
			{ id: 'user-1', ts: 2, role: 'user', text: 'Keep me' }
		],
		activities: undefined,
		findings: undefined,
		todos: undefined,
		report: undefined,
		secretNames: ['QA_USER', 'QA_PASSWORD']
	});
	const running = fullSession({
		id: SECOND_RUN_ID,
		status: 'running',
		messages: undefined,
		secretNames: undefined
	});
	const result = prepare([waiting, running]);

	assert.deepEqual(result.sessions.map(session => session.status), ['interrupted', 'interrupted']);
	assert.equal(result.sessions[0].pendingQuestion, undefined);
	assert.equal(result.sessions[1].pendingQuestion, undefined);
	assert.deepEqual(result.sessions[0].messages.map(message => message.id), ['user-1']);
	assert.deepEqual(result.sessions[0].activities, []);
	assert.deepEqual(result.sessions[0].findings, []);
	assert.deepEqual(result.sessions[0].todos, []);
	assert.deepEqual(result.sessions[1].messages, []);
	assert.deepEqual(result.sessions[0].secretNames, []);
	assert.deepEqual(result.sessions[1].secretNames, []);
	assert.equal(result.summary.interruptedSessions, 2);
	assert.equal(result.summary.removedThinkingMessages, 1);
	assert.equal(result.summary.clearedSecretNameEntries, 2);
});

test('unknown, live-only, and credential-shaped fields never survive the strict allowlist', () => {
	const rawSecret = 'do-not-import-this-value';
	const session = fullSession({
		password: rawSecret,
		apiKey: rawSecret,
		runtime: { authorization: rawSecret },
		bridge: { cookie: rawSecret },
		controller: { token: rawSecret },
		frame: rawSecret,
		unknown: rawSecret,
		messages: [{
			id: 'message-1', ts: 1, role: 'user',
			text: `A leaked value would be ${rawSecret}`,
			credentialValue: rawSecret,
			unknown: rawSecret
		}],
		activities: [{
			id: 'activity-1', ts: 2, status: 'done', input: {
				url: 'https://example.com/', password: rawSecret,
				nested: { api_key: rawSecret, safe: 'kept' }
			}
		}]
	});
	const prepared = prepare([session]).sessions[0];
	const serialized = JSON.stringify(prepared);

	assert.equal(serialized.includes(rawSecret), false);
	assert.match(prepared.messages[0].text, /\[REDACTED\]/);
	assert.deepEqual(prepared.activities[0].input, {
		url: 'https://example.com/', nested: { safe: 'kept' }
	});
	assert.deepEqual(Object.keys(prepared), [
		'id', 'title', 'createdAt', 'updatedAt', 'status', 'targetUrl',
		'messages', 'activities', 'findings', 'todos', 'report',
		'pendingQuestion', 'contextUsage', 'secretNames'
	]);
});

test('malformed JSON and non-array roots fail before producing a dry run', () => {
	assert.throws(() => prepareLegacySessions('{broken'), /not valid JSON/i);
	assert.throws(() => prepareLegacySessions('{}'), /top-level array/i);
	assert.throws(() => prepareLegacySessions(42), /JSON string or byte buffer/i);
});

test('run UUIDs must be canonical and unique', () => {
	assert.throws(
		() => prepare([fullSession({ id: RUN_ID.toUpperCase() })]),
		/canonical UUID/i
	);
	assert.throws(
		() => prepare([fullSession(), fullSession()]),
		/duplicated/i
	);
});

test('timestamps, statuses, and nested shapes are validated fail closed', () => {
	for (const createdAt of [-1, Number.NaN, Number.POSITIVE_INFINITY, '100']) {
		assert.throws(() => prepare([fullSession({ createdAt })]), /timestamp/i);
	}
	assert.throws(() => prepare([fullSession({ status: 'unknown' })]), /unsupported/i);
	assert.throws(() => prepare([fullSession({ messages: {} })]), /messages must be an array/i);
	assert.throws(() => prepare([fullSession({ activities: [null] })]), /must be an object/i);
	assert.throws(() => prepare([fullSession({ findings: [{ severity: 'high' }] })]), TypeError);
	assert.throws(() => prepare([fullSession({ todos: [{ text: 'Check', status: 'unknown' }] })]), /unsupported/i);
	assert.throws(() => prepare([fullSession({ contextUsage: { percentage: 101, used: 1, window: 1 } })]), /exceed 100/i);
});

test('file reads enforce both size checks, preserve the source, and return a hash summary', t => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-legacy-import-'));
	const filePath = path.join(directory, 'sessions.json');
	const raw = JSON.stringify([fullSession()]);
	fs.writeFileSync(filePath, raw);
	t.after(() => {
		const expected = path.join(os.tmpdir(), 'qase-legacy-import-');
		assert.ok(directory.startsWith(expected));
		fs.rmSync(directory, { recursive: true, force: true });
	});

	const before = fs.readFileSync(filePath);
	const result = readLegacySessions(filePath, { maxBytes: before.length });
	const after = fs.readFileSync(filePath);

	assert.deepEqual(after, before);
	assert.equal(result.source.path, path.resolve(filePath));
	assert.equal(result.summary.sourceHash, result.source.sha256);
	assert.equal(result.summary.sourceBytes, before.length);
	assert.throws(
		() => readLegacySessions(filePath, { maxBytes: before.length - 1 }),
		/exceeds the configured/i
	);
	assert.throws(() => prepareLegacySessions('[]', { maxBytes: 0 }), /positive safe integer/i);
});
