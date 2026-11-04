import assert from 'node:assert/strict';
import test from 'node:test';
import {
	BROWSER_POLICY_CODES,
	classifyDestructiveAction,
	createBrowserPolicy,
	isRecognizedMeetingUrl,
	isPrivateOrReservedAddress
} from './browserPolicy.js';

const publicDns = async () => [
	{ address: '93.184.216.34', family: 4 },
	{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }
];

function productionPolicy(overrides = {}) {
	return createBrowserPolicy({
		getTargetUrl: () => 'https://app.example.test/start',
		environment: { NODE_ENV: 'production' },
		resolveHost: publicDns,
		...overrides
	});
}

test('recognizes private and reserved IPv4 and IPv6 ranges', () => {
	for (const address of [
		'0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254',
		'172.16.0.1', '192.88.99.1', '192.168.1.2', '198.18.0.1', '203.0.113.7', '224.0.0.1',
		'::', '::1', '64:ff9b:1::1', '100::1', '3fff::1', '5f00::1', 'fd00::1',
		'fe80::1', 'fec0::1', 'ff02::1', '2001::1', '2001:2::1', '2001:20::1',
		'2001:db8::1', '2002::1', '::ffff:127.0.0.1'
	]) {
		assert.equal(isPrivateOrReservedAddress(address), true, address);
	}
	for (const address of ['8.8.8.8', '93.184.216.34', '2001:4860:4860::8888']) {
		assert.equal(isPrivateOrReservedAddress(address), false, address);
	}
});

test('rejects unsafe URL schemes and URLs with embedded credentials', async () => {
	const policy = productionPolicy();
	assert.equal((await policy.evaluateNavigation('file:///etc/passwd')).code, BROWSER_POLICY_CODES.UNSAFE_SCHEME);
	assert.equal((await policy.evaluateNavigation('javascript:alert(1)')).code, BROWSER_POLICY_CODES.UNSAFE_SCHEME);
	assert.equal((await policy.evaluateNavigation('wss://app.example.test/events')).code, BROWSER_POLICY_CODES.UNSAFE_SCHEME);
	assert.equal(
		(await policy.evaluateNavigation('https://user:secret@app.example.test/')).code,
		BROWSER_POLICY_CODES.EMBEDDED_CREDENTIALS
	);
	assert.equal((await policy.evaluateNavigation('not a URL')).code, BROWSER_POLICY_CODES.INVALID_URL);
});

test('allows only target-scope top-level navigation unless an operator allowlists an origin', async () => {
	const policy = productionPolicy();
	assert.equal((await policy.evaluateNavigation('https://app.example.test/account')).allowed, true);
	assert.equal(
		(await policy.evaluateNavigation('https://identity.example.test/login')).code,
		BROWSER_POLICY_CODES.OUT_OF_SCOPE_NAVIGATION
	);

	const allowlisted = productionPolicy({
		environment: {
			NODE_ENV: 'production',
			QASE_BROWSER_ALLOWED_ORIGINS: 'https://identity.example.test, https://*.trusted.example'
		}
	});
	assert.equal((await allowlisted.evaluateNavigation('https://identity.example.test/login')).allowed, true);
	assert.equal((await allowlisted.evaluateNavigation('https://login.trusted.example/')).allowed, true);
	assert.equal(
		(await allowlisted.evaluateNavigation('https://trusted.example/')).code,
		BROWSER_POLICY_CODES.OUT_OF_SCOPE_NAVIGATION
	);
});

test('a declared studio meeting room authorizes only the same room on the meeting host', async () => {
	const policy = createBrowserPolicy({
		getTargetUrl: () => 'https://studio.drytis.ai/meeting/mtg-Aajxsxmsq9bGgW',
		environment: { NODE_ENV: 'production' },
		resolveHost: publicDns
	});
	// The exact room, with the query the guest hand-off appends, is the alias.
	assert.equal(
		(await policy.evaluateNavigation('https://meeting.drytis.dev/meeting/mtg-Aajxsxmsq9bGgW?workspaceUrl=https%3A%2F%2Fstudio.drytis.ai&guest=true')).allowed,
		true
	);
	// The origin is NOT granted: another room, another path, and the bare origin stay blocked.
	assert.equal(
		(await policy.evaluateNavigation('https://meeting.drytis.dev/meeting/mtg-anotherRoom1')).code,
		BROWSER_POLICY_CODES.OUT_OF_SCOPE_NAVIGATION
	);
	assert.equal(
		(await policy.evaluateNavigation('https://meeting.drytis.dev/login')).code,
		BROWSER_POLICY_CODES.OUT_OF_SCOPE_NAVIGATION
	);
	assert.equal(
		(await policy.evaluateNavigation('https://meeting.drytis.dev/')).code,
		BROWSER_POLICY_CODES.OUT_OF_SCOPE_NAVIGATION
	);
	// A non-meeting target never earns the alias.
	const other = createBrowserPolicy({
		getTargetUrl: () => 'https://studio.drytis.ai/dashboard',
		environment: { NODE_ENV: 'production' },
		resolveHost: publicDns
	});
	assert.equal(
		(await other.evaluateNavigation('https://meeting.drytis.dev/dashboard')).code,
		BROWSER_POLICY_CODES.OUT_OF_SCOPE_NAVIGATION
	);
});

test('allows a same-host HTTP to HTTPS upgrade but not a downgrade', async () => {
	const upgrade = createBrowserPolicy({
		getTargetUrl: () => 'http://app.example.test/start',
		environment: { NODE_ENV: 'production' },
		resolveHost: publicDns
	});
	assert.equal((await upgrade.evaluateNavigation('https://app.example.test/')).allowed, true);

	const downgrade = productionPolicy();
	assert.equal(
		(await downgrade.evaluateNavigation('http://app.example.test/')).code,
		BROWSER_POLICY_CODES.OUT_OF_SCOPE_NAVIGATION
	);
});

test('allows public third-party subresources while blocking private and metadata networks', async () => {
	const resolutions = new Map([
		['cdn.example.test', [{ address: '1.1.1.1', family: 4 }]],
		['rebound.example.test', [{ address: '10.0.0.8', family: 4 }]]
	]);
	const policy = productionPolicy({
		resolveHost: async hostname => resolutions.get(hostname) ?? publicDns()
	});
	assert.equal((await policy.evaluateRequest('https://cdn.example.test/app.js')).allowed, true);
	assert.equal((await policy.evaluateRequest('wss://cdn.example.test/events')).allowed, true);
	assert.equal(
		(await policy.evaluateRequest('http://169.254.169.254/latest/meta-data')).code,
		BROWSER_POLICY_CODES.PRIVATE_NETWORK
	);
	assert.equal(
		(await policy.evaluateRequest('ws://169.254.169.254/events')).code,
		BROWSER_POLICY_CODES.PRIVATE_NETWORK
	);
	assert.equal(
		(await policy.evaluateRequest('https://rebound.example.test/internal')).code,
		BROWSER_POLICY_CODES.PRIVATE_NETWORK
	);
	assert.equal(
		(await policy.evaluateRequest('http://metadata.google.internal/computeMetadata/v1/')).code,
		BROWSER_POLICY_CODES.PRIVATE_NETWORK
	);
});

test('private targets are blocked by default everywhere; dev must opt in, production needs a trusted host allowlist', async () => {
	const development = createBrowserPolicy({
		getTargetUrl: () => 'http://127.0.0.1:5173/',
		environment: { NODE_ENV: 'development' }
	});
	assert.equal((await development.evaluateNavigation('http://127.0.0.1:5173/demo')).allowed, false);

	const optedIn = createBrowserPolicy({
		getTargetUrl: () => 'http://127.0.0.1:5173/',
		environment: { NODE_ENV: 'development', QASE_ALLOW_PRIVATE_NETWORK: 'true' }
	});
	assert.equal((await optedIn.evaluateNavigation('http://127.0.0.1:5173/demo')).allowed, true);

	const productionOptOutIgnored = createBrowserPolicy({
		getTargetUrl: () => 'http://127.0.0.1:5173/',
		environment: { NODE_ENV: 'production', QASE_ALLOW_PRIVATE_NETWORK: 'true' }
	});
	assert.equal((await productionOptOutIgnored.evaluateNavigation('http://127.0.0.1:5173/demo')).allowed, false);

	for (const nodeEnv of ['staging', 'Production', '']) {
		const nonDevelopmentOptOutIgnored = createBrowserPolicy({
			getTargetUrl: () => 'http://127.0.0.1:5173/',
			environment: { NODE_ENV: nodeEnv, QASE_ALLOW_PRIVATE_NETWORK: 'true' }
		});
		assert.equal(
			(await nonDevelopmentOptOutIgnored.evaluateNavigation('http://127.0.0.1:5173/demo')).allowed,
			false,
			`private-network opt-out must be ignored for NODE_ENV=${JSON.stringify(nodeEnv)}`
		);
	}

	const production = createBrowserPolicy({
		getTargetUrl: () => 'http://127.0.0.1:5173/',
		environment: {
			NODE_ENV: 'production',
			QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: '127.0.0.1'
		}
	});
	assert.equal((await production.evaluateNavigation('http://127.0.0.1:5173/demo')).allowed, true);
});

test('the instance own public origin is reachable even when it resolves to reserved space', async () => {
	const own = createBrowserPolicy({
		getTargetUrl: () => 'https://qase-2-1-vbvclu.drytis.dev/',
		environment: { NODE_ENV: 'production', QASE_PUBLIC_URL: 'https://qase-2-1-vbvclu.drytis.dev/' },
		resolveHost: async () => [{ address: '10.2.145.7' }]
	});
	assert.equal((await own.evaluateNavigation('https://qase-2-1-vbvclu.drytis.dev/demo')).allowed, true,
		'own origin must be allowed despite the reserved address');

	// Look-alikes must NOT inherit the allowance (suffix/substring is not a match).
	const lookalike = createBrowserPolicy({
		getTargetUrl: () => 'https://evil-qase-2-1-vbvclu.drytis.dev.attacker.example/',
		environment: { NODE_ENV: 'production', QASE_PUBLIC_URL: 'https://qase-2-1-vbvclu.drytis.dev/' },
		resolveHost: async () => [{ address: '10.0.0.5' }]
	});
	assert.equal((await lookalike.evaluateNavigation('https://evil-qase-2-1-vbvclu.drytis.dev.attacker.example/demo')).allowed, false,
		'only the exact own-origin hostname is allowed');

	// Other private hosts stay blocked even when the own origin is configured.
	const other = createBrowserPolicy({
		getTargetUrl: () => 'https://internal.corp.example/',
		environment: { NODE_ENV: 'production', QASE_PUBLIC_URL: 'https://qase-2-1-vbvclu.drytis.dev/' },
		resolveHost: async host => [{ address: host === 'internal.corp.example' ? '10.9.9.9' : '93.184.216.34' }]
	});
	assert.equal((await other.evaluateNavigation('https://internal.corp.example/')).allowed, false,
		'unrelated private hosts remain blocked');

	// A malformed QASE_PUBLIC_URL must not open anything up.
	const malformed = createBrowserPolicy({
		getTargetUrl: () => 'http://10.0.0.9/',
		environment: { NODE_ENV: 'production', QASE_PUBLIC_URL: 'not a url' }
	});
	assert.equal((await malformed.evaluateNavigation('http://10.0.0.9/')).allowed, false);
});

test('fails closed when production DNS cannot prove a destination is public', async () => {
	const policy = productionPolicy({ resolveHost: async () => { throw new Error('offline'); } });
	assert.equal(
		(await policy.evaluateRequest('https://cdn.example.test/app.js')).code,
		BROWSER_POLICY_CODES.DNS_FAILED
	);
});

test('classifies destructive actions without blocking benign login and send controls', () => {
	assert.equal(classifyDestructiveAction('click', { text: 'Delete project' })?.category, 'delete');
	assert.equal(classifyDestructiveAction('fill', { ariaLabel: 'Type DELETE to confirm' })?.category, 'delete');
	assert.equal(classifyDestructiveAction('pressKey', { key: 'Delete' })?.category, 'delete');
	assert.equal(classifyDestructiveAction('click', { text: 'Pay now' })?.category, 'commerce');
	assert.equal(classifyDestructiveAction('click', { text: 'Sign in' }), undefined);
	assert.equal(classifyDestructiveAction('click', { text: 'Send' }), undefined);
	assert.equal(classifyDestructiveAction('fill', { ariaLabel: 'Password' }), undefined);
});

test('requires an explicit recent answer and grants only a short matching destructive flow', () => {
	let clock = 10_000;
	const policy = createBrowserPolicy({
		getTargetUrl: () => 'https://app.example.test/',
		environment: { NODE_ENV: 'test' },
		now: () => clock,
		confirmationTtlMs: 1_000
	});
	const descriptor = { text: 'Delete project', url: 'https://app.example.test/projects/1' };
	const first = policy.authorizeAction('click', descriptor, []);
	assert.equal(first.allowed, false);
	assert.equal(first.code, BROWSER_POLICY_CODES.CONFIRMATION_REQUIRED);
	assert.equal(first.requiresConfirmation, true);

	clock += 1;
	const answer = [{ role: 'user', kind: 'answer', text: 'Yes, proceed.', ts: clock }];
	assert.equal(policy.authorizeAction('click', descriptor, answer).allowed, true);
	assert.equal(policy.authorizeAction('fill', {
		ariaLabel: 'Type DELETE to confirm',
		url: 'https://app.example.test/projects/1/confirm'
	}, answer).allowed, true);
	assert.equal(policy.authorizeAction('click', descriptor, answer).code, BROWSER_POLICY_CODES.CONFIRMATION_REQUIRED);
});

test('an explicit refusal never authorizes the destructive action', () => {
	let clock = 20_000;
	const policy = createBrowserPolicy({
		getTargetUrl: () => 'https://app.example.test/',
		environment: { NODE_ENV: 'test' },
		now: () => clock
	});
	const descriptor = { text: 'Purchase', url: 'https://app.example.test/checkout' };
	policy.authorizeAction('click', descriptor, []);
	clock += 1;
	const decision = policy.authorizeAction('click', descriptor, [
		{ role: 'user', kind: 'answer', text: 'No, cancel.', ts: clock }
	]);
	assert.equal(decision.allowed, false);
	assert.equal(decision.code, BROWSER_POLICY_CODES.CONFIRMATION_DECLINED);
	assert.equal(decision.requiresConfirmation, false);
});

test('observed meeting exceptions are exact paths and preserve DNS and scheme boundaries', async () => {
	const policy = productionPolicy();
	const source = 'https://app.example.test/events';
	const meeting = 'https://meet.google.com/abc-defg-hij?authuser=0';
	assert.equal((await policy.evaluateNavigation(meeting)).allowed, false);
	assert.equal((await policy.allowObservedMeetingLink(meeting, source)).allowed, true);
	assert.equal((await policy.evaluateNavigation(meeting)).allowed, true);
	assert.equal((await policy.evaluateNavigation('https://meet.google.com/aaa-bbbb-ccc')).allowed, false);
	assert.equal((await policy.evaluateNavigation('https://meet.google.com/')).allowed, false);
	assert.equal((await policy.allowObservedMeetingLink('https://meet.google.com.evil.test/abc-defg-hij', source)).allowed, false);
	assert.equal((await policy.allowObservedMeetingLink('http://meet.google.com/abc-defg-hij', source)).allowed, false);
	assert.equal((await policy.allowObservedMeetingLink('https://meet.google.com/aaa-bbbb-ccc', 'https://untrusted.test/')).allowed, false);
	const privateDns = productionPolicy({ resolveHost: async host => [{ address: host === 'meet.google.com' ? '127.0.0.1' : '93.184.216.34' }] });
	assert.equal((await privateDns.allowObservedMeetingLink(meeting, source)).code, BROWSER_POLICY_CODES.PRIVATE_NETWORK);
	assert.equal(isRecognizedMeetingUrl('https://us02web.zoom.us/j/123456789'), true);
	assert.equal(isRecognizedMeetingUrl('https://teams.microsoft.com/l/meetup-join/meeting-id/0?context=abc'), true);
	assert.equal(isRecognizedMeetingUrl('https://tenant.webex.com/meet/test'), true);
});

test('meeting participation and recording require explicit confirmation', () => {
	for (const text of ['Join', 'Ask to join', 'Request to join', 'Join the meeting', 'Join meeting', 'Join now', 'Start call', 'Record meeting']) {
		assert.equal(classifyDestructiveAction('click', { text })?.category, 'meeting-participation', text);
	}
	for (const text of ['Start microphone', 'Start recording', 'Mute microphone', 'Unmute microphone', 'Stop microphone']) {
		assert.equal(classifyDestructiveAction('click', { text }), undefined, 'Synthetic local audio controls remain testable');
	}
	assert.equal(classifyDestructiveAction('click', { text: 'Enable microphone' }), undefined);
	assert.equal(classifyDestructiveAction('click', { text: 'Mute microphone' }), undefined);
});

// ---- #17989: run-scoped authorization policy for approved safe operations.

test('#17989 common casual approvals are recognized affirmations', () => {
	let clock = 100_000;
	const descriptor = { text: 'Delete project', url: 'https://app.example.test/projects/1' };
	for (const text of ['OK, go ahead.', 'Sure, proceed.', 'Yep, do it.', 'Sounds good — please do.']) {
		// Fresh policy per phrase: each approval arms its own bounded grant.
		const policy = createBrowserPolicy({
			getTargetUrl: () => 'https://app.example.test/',
			environment: { NODE_ENV: 'test' },
			now: () => clock
		});
		assert.equal(policy.authorizeAction('click', descriptor, []).allowed, false);
		const decision = policy.authorizeAction('click', descriptor, [
			{ role: 'user', kind: 'answer', text, ts: clock + 1 }
		]);
		assert.equal(decision.allowed, true, text);
		clock += 10_000;
	}
});

test('#17989 explicit "without asking again" arms a run-scoped grant that never expires or re-prompts', () => {
	let clock = 200_000;
	const policy = createBrowserPolicy({
		getTargetUrl: () => 'https://app.example.test/',
		environment: { NODE_ENV: 'test' },
		now: () => clock,
		confirmationTtlMs: 1_000
	});
	const descriptor = { text: 'Remove item', url: 'https://app.example.test/items/4' };
	assert.equal(policy.authorizeAction('click', descriptor, []).code, BROWSER_POLICY_CODES.CONFIRMATION_REQUIRED);
	clock += 1;
	const answer = [{ role: 'user', kind: 'answer', text: 'Yes — remove these for the rest of the run, without asking again.', ts: clock }];
	const first = policy.authorizeAction('click', descriptor, answer);
	assert.equal(first.allowed, true);
	assert.equal(first.runScoped, true, 'run-scoped approval recorded');
	// Far beyond the old 2-use/2-min cap: the SAME category+origin keeps
	// executing without another confirmation.
	clock += 60 * 60_000;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const again = policy.authorizeAction('click', descriptor, []);
		assert.equal(again.allowed, true, `attempt ${attempt} stays authorized`);
		assert.equal(again.runScoped, true);
	}
});

test('#17989 a run-scoped grant never crosses risk category or origin', () => {
	let clock = 300_000;
	const policy = createBrowserPolicy({
		getTargetUrl: () => 'https://app.example.test/',
		environment: { NODE_ENV: 'test' },
		now: () => clock
	});
	const remove = { text: 'Remove item', url: 'https://app.example.test/items/4' };
	assert.equal(policy.authorizeAction('click', remove, []).allowed, false);
	clock += 1;
	const scoped = policy.authorizeAction('click', remove, [
		{ role: 'user', kind: 'answer', text: 'Yes, without asking again for this run.', ts: clock }
	]);
	assert.equal(scoped.runScoped, true);
	// Different category (purchase) still requires explicit confirmation.
	const purchase = { text: 'Purchase', url: 'https://app.example.test/checkout' };
	assert.equal(policy.authorizeAction('click', purchase, []).code, BROWSER_POLICY_CODES.CONFIRMATION_REQUIRED);
	// Same category on a different origin still requires confirmation.
	const elsewhere = { text: 'Remove item', url: 'https://other.example.test/items/9' };
	assert.equal(policy.authorizeAction('click', elsewhere, []).code, BROWSER_POLICY_CODES.CONFIRMATION_REQUIRED);
	// Declining the new category never inherits the run-scoped grant: the
	// decline is recorded against the purchase confirmation specifically.
	clock += 1;
	const declined = policy.authorizeAction('click', purchase, [
		{ role: 'user', kind: 'answer', text: 'No, cancel.', ts: clock }
	]);
	assert.equal([BROWSER_POLICY_CODES.CONFIRMATION_DECLINED, BROWSER_POLICY_CODES.CONFIRMATION_REQUIRED].includes(declined.code), true, `decline must not allow, got ${declined.code}`);
	assert.equal(declined.allowed, false);
});

test('#17989 run-scoped grants persist across bridge rebuilds via the session record', () => {
	let clock = 400_000;
	const now = () => clock;
	const store = { grant: null };
	const getTargetUrl = () => 'https://app.example.test/';
	const environment = { NODE_ENV: 'test' };
	const descriptor = { text: 'Delete project', url: 'https://app.example.test/projects/1' };

	const first = createBrowserPolicy({
		getTargetUrl, environment, now,
		getBrowserActionGrant: () => store.grant,
		setBrowserActionGrant: grant => { store.grant = grant; }
	});
	assert.equal(first.authorizeAction('click', descriptor, []).allowed, false);
	clock += 1;
	const answer = [{ role: 'user', kind: 'answer', text: 'Confirmed — continue without asking again for this session.', ts: clock }];
	assert.equal(first.authorizeAction('click', descriptor, answer).allowed, true);
	assert.equal(store.grant?.runScoped, true, 'run-scoped grant persisted to the session record');

	// Bridge rebuild (browser closed/reopened, process restart): a NEW policy
	// hydrates the persisted grant and does not re-prompt for the same class.
	clock += 90 * 60_000; // long after any TTL — persistence, not the timer, carries it
	const rebuilt = createBrowserPolicy({
		getTargetUrl, environment, now,
		getBrowserActionGrant: () => store.grant,
		setBrowserActionGrant: grant => { store.grant = grant; }
	});
	const afterRebuild = rebuilt.authorizeAction('click', descriptor, []);
	assert.equal(afterRebuild.allowed, true, 'rebuilt bridge keeps the run-scoped authorization');
	assert.equal(afterRebuild.runScoped, true);

	// clearGrant drops the persisted authorization.
	rebuilt.clearGrant();
	assert.equal(store.grant, null);
	const afterClear = rebuilt.authorizeAction('click', descriptor, []);
	assert.equal(afterClear.code, BROWSER_POLICY_CODES.CONFIRMATION_REQUIRED);
});

test('#17989 bounded grants still expire and are NOT persisted', () => {
	let clock = 500_000;
	const store = { grant: null };
	const policy = createBrowserPolicy({
		getTargetUrl: () => 'https://app.example.test/',
		environment: { NODE_ENV: 'test' },
		now: () => clock,
		confirmationTtlMs: 1_000,
		getBrowserActionGrant: () => store.grant,
		setBrowserActionGrant: grant => { store.grant = grant; }
	});
	const descriptor = { text: 'Delete project', url: 'https://app.example.test/projects/1' };
	assert.equal(policy.authorizeAction('click', descriptor, []).allowed, false);
	clock += 1;
	const decision = policy.authorizeAction('click', descriptor, [
		{ role: 'user', kind: 'answer', text: 'Yes, proceed.', ts: clock }
	]);
	assert.equal(decision.allowed, true);
	assert.equal(decision.runScoped, false);
	assert.equal(store.grant, null, 'plain approval persists nothing');
	clock += 2_000;
	assert.equal(policy.authorizeAction('click', descriptor, []).code, BROWSER_POLICY_CODES.CONFIRMATION_REQUIRED);
});
