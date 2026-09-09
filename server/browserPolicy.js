import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const DEFAULT_CONFIRMATION_TTL_MS = 2 * 60_000;
const DEFAULT_CONFIRMATION_USES = 2;

export const BROWSER_POLICY_CODES = Object.freeze({
	INVALID_URL: 'BROWSER_INVALID_URL',
	UNSAFE_SCHEME: 'BROWSER_UNSAFE_SCHEME',
	EMBEDDED_CREDENTIALS: 'BROWSER_EMBEDDED_CREDENTIALS',
	TARGET_REQUIRED: 'BROWSER_TARGET_REQUIRED',
	OUT_OF_SCOPE_NAVIGATION: 'BROWSER_OUT_OF_SCOPE_NAVIGATION',
	PRIVATE_NETWORK: 'BROWSER_PRIVATE_NETWORK_BLOCKED',
	DNS_FAILED: 'BROWSER_DNS_RESOLUTION_FAILED',
	MEETING_LINK_NOT_SUPPORTED: 'BROWSER_MEETING_LINK_NOT_SUPPORTED',
	CONFIRMATION_REQUIRED: 'DESTRUCTIVE_ACTION_CONFIRMATION_REQUIRED',
	CONFIRMATION_DECLINED: 'DESTRUCTIVE_ACTION_CONFIRMATION_DECLINED'
});

const DESTRUCTIVE_PATTERNS = [
	{ category: 'meeting-participation', pattern: /\b((?:ask|request) to join|join (?:a |the )?(?:now|meeting|call|room)|start (?:a |the )?(?:meeting|call)|record (?:meeting|call))\b/i },
	{ category: 'delete', pattern: /\b(delete|destroy|erase|wipe|purge)\b/i },
	{ category: 'remove', pattern: /\bremove\b/i },
	{ category: 'reset', pattern: /\b(reset|factory[ -]?reset)\b/i },
	{ category: 'commerce', pattern: /\b(buy now|purchase|place (?:the )?order|pay now|submit payment|confirm (?:payment|order)|complete (?:checkout|purchase)|subscribe now|start (?:a )?(?:paid )?subscription)\b/i },
	{ category: 'account', pattern: /\b(close|deactivate|disable|terminate|cancel)\s+(?:my\s+)?(?:account|workspace|project|organization|subscription|plan|booking|order|service|user)\b/i },
	{ category: 'security', pattern: /\b(revoke (?:access|key|token|permission)|rotate (?:key|secret)|change password|reset password)\b/i },
	{ category: 'external-side-effect', pattern: /\b(send (?:an? )?(?:email|message|invitation)|invite (?:user|member|people)|publish|deploy (?:to )?production)\b/i },
	{ category: 'settings', pattern: /\b(save|apply|update|change)\s+(?:account |billing |security )?(?:settings|permissions|password)\b/i }
];

const AFFIRMATIVE = /^\s*(?:yes|y|confirm(?:ed)?|proceed|continue|allow|approve(?:d)?|do it|go ahead)(?:\s|[.,;:!]|$)/i;
const NEGATIVE = /^\s*(?:no|n|deny|decline|cancel|do not|don't|stop)(?:\s|[.,;:!]|$)/i;

function cleanHost(hostname) {
	return String(hostname ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function splitCsv(value) {
	return String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
}

function safeUrlLabel(input) {
	try {
		const url = input instanceof URL ? input : new URL(String(input));
		return `${url.origin}${url.pathname}`.slice(0, 300);
	} catch {
		return '(invalid URL)';
	}
}

function safeOriginLabel(input) {
	try {
		return new URL(String(input)).origin;
	} catch {
		return '(unknown origin)';
	}
}

/** Only known web meeting entry paths qualify for an observed-link exception. */
export function isRecognizedMeetingUrl(input) {
	let url;
	try { url = new URL(String(input)); } catch { return false; }
	if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
	const host = cleanHost(url.hostname);
	return (host === 'meet.google.com' && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(url.pathname)) ||
		((host === 'zoom.us' || host.endsWith('.zoom.us')) && /^\/(?:j\/\d+|wc\/(?:join\/\d+|\d+\/join))\/?$/.test(url.pathname)) ||
		(['teams.microsoft.com', 'teams.live.com'].includes(host) && /^\/(?:l\/meetup-join\/[^/]+\/[^/]+|meet\/[^/]+)\/?$/.test(url.pathname)) ||
		(host.endsWith('.webex.com') && /^\/(?:meet|join)\/[^/]+\/?$/.test(url.pathname));
}

function meetingDestinationKey(url) {
	return `${url.origin}${url.pathname}`;
}

function parseOriginRule(value) {
	try {
		const wildcard = value.match(/^(https?):\/\/\*\.([^/:?#]+)(?::(\d+))?\/?$/i);
		if (wildcard) {
			return {
				protocol: `${wildcard[1].toLowerCase()}:`,
				hostSuffix: cleanHost(wildcard[2]),
				port: wildcard[3] ?? ''
			};
		}
		const url = new URL(value);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
			return undefined;
		}
		return { origin: url.origin };
	} catch {
		return undefined;
	}
}

function originRuleMatches(url, rule) {
	if (rule.origin) {
		return url.origin === rule.origin;
	}
	const hostname = cleanHost(url.hostname);
	return url.protocol === rule.protocol &&
		Boolean(hostname) && hostname !== rule.hostSuffix &&
		hostname.endsWith(`.${rule.hostSuffix}`) &&
		(url.port || '') === rule.port;
}

function hostRuleMatches(hostname, rule) {
	const host = cleanHost(hostname);
	const candidate = cleanHost(rule).replace(/^\*\./, '');
	if (!host || !candidate) return false;
	return rule.trim().startsWith('*.')
		? host !== candidate && host.endsWith(`.${candidate}`)
		: host === candidate;
}

function parseIpv4(address) {
	const parts = String(address).split('.');
	if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
		return undefined;
	}
	return parts.map(Number);
}

/**
 * Returns true for non-public IP space. These ranges include RFC1918,
 * loopback/link-local, CGNAT, documentation/benchmark ranges, multicast and
 * reserved space. A browser test has no legitimate reason to reach them unless
 * an operator has explicitly allowlisted the host.
 */
export function isPrivateOrReservedAddress(address) {
	const normalized = cleanHost(address);
	const family = isIP(normalized);
	if (family === 4) {
		const [a, b, c] = parseIpv4(normalized);
		return a === 0 || a === 10 || a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 0 && c === 0) ||
			(a === 192 && b === 0 && c === 2) ||
			(a === 192 && b === 168) ||
			(a === 192 && b === 88 && c === 99) ||
			(a === 198 && (b === 18 || b === 19)) ||
			(a === 198 && b === 51 && c === 100) ||
			(a === 203 && b === 0 && c === 113) ||
			a >= 224;
	}
	if (family === 6) {
		if (normalized.startsWith('::ffff:')) {
			const mapped = normalized.slice('::ffff:'.length);
			return isIP(mapped) === 4 ? isPrivateOrReservedAddress(mapped) : true;
		}
		return normalized === '::' || normalized === '::1' ||
			normalized.startsWith('64:ff9b:1:') ||
			normalized.startsWith('100:') ||
			normalized.startsWith('3fff:') ||
			normalized.startsWith('5f00:') ||
			/^(?:fc|fd)/.test(normalized) ||
			/^fe[89abcdef]/.test(normalized) ||
			normalized.startsWith('ff') ||
			normalized.startsWith('2001::') ||
			/^2001:0{1,4}:/.test(normalized) ||
			normalized.startsWith('2001:2:') ||
			/^2001:2[0-9a-f]:/.test(normalized) ||
			normalized.startsWith('2001:db8:') ||
			normalized.startsWith('2001:10:') ||
			normalized.startsWith('2002:');
	}
	return false;
}

function isLocalHostname(hostname) {
	const host = cleanHost(hostname);
	return host === 'localhost' || host.endsWith('.localhost') ||
		host.endsWith('.local') || host.endsWith('.internal') ||
		host === 'metadata' || host === 'instance-data' ||
		host === 'metadata.google.internal' || host.endsWith('.home.arpa');
}

function normalizeResolvedAddresses(result) {
	const entries = Array.isArray(result) ? result : [result];
	return entries.map(entry => typeof entry === 'string' ? entry : entry?.address).filter(Boolean);
}

async function defaultResolveHost(hostname) {
	return lookup(hostname, { all: true, verbatim: true });
}

function success(url) {
	return { allowed: true, url };
}

function blocked(code, message, extra = {}) {
	return { allowed: false, code, message, ...extra };
}

function asBlockedResult(decision) {
	const confirmation = decision.confirmation;
	return {
		success: false,
		blocked: true,
		policy: 'browser-safety',
		code: decision.code,
		requiresConfirmation: Boolean(decision.requiresConfirmation),
		...(confirmation ? { confirmation } : {}),
		error: decision.message
	};
}

function descriptorText(descriptor) {
	if (!descriptor || typeof descriptor !== 'object') return '';
	return [
		descriptor.label,
		descriptor.text,
		descriptor.ariaLabel,
		descriptor.title,
		descriptor.name,
		descriptor.testId,
		descriptor.selector,
		descriptor.id,
		descriptor.className,
		descriptor.formAction
	].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export function classifyDestructiveAction(action, descriptor = {}) {
	const normalizedAction = action === 'key' ? 'pressKey' : action;
	if (!['click', 'fill', 'pressKey', 'typeText'].includes(normalizedAction)) {
		return undefined;
	}

	const key = String(descriptor.key ?? '');
	if (normalizedAction === 'pressKey' && /^delete$/i.test(key)) {
		return { category: 'delete', phrase: 'Delete key', label: descriptorText(descriptor) || 'focused element' };
	}
	if (normalizedAction === 'pressKey' && key && !/^(?:enter|numpadenter|space)$/i.test(key)) {
		return undefined;
	}

	const text = descriptorText(descriptor);
	if (['click', 'pressKey'].includes(normalizedAction) &&
		[descriptor.text, descriptor.ariaLabel, descriptor.label, descriptor.name].some(label => /^\s*join\s*$/i.test(String(label ?? '')))) {
		return { category: 'meeting-participation', phrase: 'Join', label: text || 'Join' };
	}
	for (const candidate of DESTRUCTIVE_PATTERNS) {
		const match = text.match(candidate.pattern);
		if (match) {
			return { category: candidate.category, phrase: match[0], label: text || 'target element' };
		}
	}
	return undefined;
}

/**
 * Browser boundary policy. It intentionally accepts dependencies so tests can
 * verify DNS and time behavior without external network access.
 */
export function createBrowserPolicy({
	getTargetUrl = () => undefined,
	environment = process.env,
	resolveHost = defaultResolveHost,
	now = () => Date.now(),
	confirmationTtlMs = DEFAULT_CONFIRMATION_TTL_MS
} = {}) {
	const production = String(environment.NODE_ENV ?? '').toLowerCase() === 'production';
	const allowedOrigins = splitCsv(environment.QASE_BROWSER_ALLOWED_ORIGINS)
		.map(parseOriginRule).filter(Boolean);
	const allowedPrivateHosts = splitCsv(environment.QASE_BROWSER_ALLOWED_PRIVATE_HOSTS);
	let pendingConfirmation;
	let grant;
	const observedMeetingLinks = new Set();

	const privateHostAllowed = hostname => allowedPrivateHosts.some(rule => hostRuleMatches(hostname, rule));

	async function validatePublicDestination(url) {
		if (!production || privateHostAllowed(url.hostname)) {
			return success(url);
		}
		const hostname = cleanHost(url.hostname);
		if (isLocalHostname(hostname) || (isIP(hostname) && isPrivateOrReservedAddress(hostname))) {
			return blocked(
				BROWSER_POLICY_CODES.PRIVATE_NETWORK,
				`Browser safety blocked private or reserved destination ${safeUrlLabel(url)}.`
			);
		}
		if (isIP(hostname)) {
			return success(url);
		}
		try {
			const addresses = normalizeResolvedAddresses(await resolveHost(hostname));
			if (addresses.length === 0) {
				return blocked(BROWSER_POLICY_CODES.DNS_FAILED, `Browser safety could not resolve ${hostname}.`);
			}
			if (addresses.some(isPrivateOrReservedAddress)) {
				return blocked(
					BROWSER_POLICY_CODES.PRIVATE_NETWORK,
					`Browser safety blocked ${hostname} because it resolves to private or reserved network space.`
				);
			}
			return success(url);
		} catch {
			return blocked(BROWSER_POLICY_CODES.DNS_FAILED, `Browser safety could not resolve ${hostname}.`);
		}
	}

	function parseDestination(input, { allowWebSocket = false } = {}) {
		let url;
		try {
			url = input instanceof URL ? input : new URL(String(input));
		} catch {
			return blocked(BROWSER_POLICY_CODES.INVALID_URL, 'Browser safety rejected an invalid destination URL.');
		}
		const allowedProtocols = allowWebSocket
			? ['http:', 'https:', 'ws:', 'wss:']
			: ['http:', 'https:'];
		if (!allowedProtocols.includes(url.protocol)) {
			return blocked(
				BROWSER_POLICY_CODES.UNSAFE_SCHEME,
				`Browser safety permits only HTTP and HTTPS destinations, not ${url.protocol || 'that scheme'}.`
			);
		}
		if (url.username || url.password) {
			return blocked(
				BROWSER_POLICY_CODES.EMBEDDED_CREDENTIALS,
				'Browser safety rejected a URL containing embedded credentials.'
			);
		}
		return success(url);
	}

	function isTopLevelAllowed(url) {
		const targetInput = getTargetUrl();
		if (!targetInput) {
			return blocked(
				BROWSER_POLICY_CODES.TARGET_REQUIRED,
				'Browser safety requires a user-declared target URL before opening a page.'
			);
		}
		const parsedTarget = parseDestination(targetInput);
		if (!parsedTarget.allowed) return parsedTarget;
		const target = parsedTarget.url;
		if (url.origin === target.origin) return success(url);
		// A same-host HTTP to HTTPS redirect is a common, strictly safer upgrade.
		if (target.protocol === 'http:' && url.protocol === 'https:' &&
			cleanHost(target.hostname) === cleanHost(url.hostname) &&
			!target.port && !url.port) {
			return success(url);
		}
		if (allowedOrigins.some(rule => originRuleMatches(url, rule))) return success(url);
		if (observedMeetingLinks.has(meetingDestinationKey(url))) return success(url);
		return blocked(
			BROWSER_POLICY_CODES.OUT_OF_SCOPE_NAVIGATION,
			`Browser safety blocked top-level navigation outside the declared target: ${safeUrlLabel(url)}. An operator can add a trusted origin to QASE_BROWSER_ALLOWED_ORIGINS.`
		);
	}

	async function evaluate(input, { topLevel = false } = {}) {
		const parsed = parseDestination(input, { allowWebSocket: !topLevel });
		if (!parsed.allowed) return parsed;
		if (topLevel) {
			const scope = isTopLevelAllowed(parsed.url);
			if (!scope.allowed) return scope;
		}
		return validatePublicDestination(parsed.url);
	}

	function latestAnswer(messages, since) {
		return [...(messages ?? [])].reverse().find(message =>
			message?.role === 'user' && message?.kind !== 'credentials' && Number(message.ts ?? 0) >= since
		);
	}

	function authorizeAction(action, descriptor = {}, messages = []) {
		const risk = classifyDestructiveAction(action, descriptor);
		if (!risk) return { allowed: true };
		const timestamp = now();
		// Bind approval to one origin and one risk category. A confirmation flow
		// may move from a list page to a modal/confirmation route, so the path is
		// deliberately not part of the grant; the strict two-use cap limits scope.
		const location = safeOriginLabel(descriptor.url ?? getTargetUrl() ?? '');

		if (grant && grant.expiresAt >= timestamp && grant.category === risk.category && grant.location === location && grant.remainingUses > 0) {
			grant.remainingUses -= 1;
			return { allowed: true, confirmationUsed: true, category: risk.category };
		}
		grant = undefined;

		if (pendingConfirmation && pendingConfirmation.expiresAt >= timestamp &&
			pendingConfirmation.category === risk.category && pendingConfirmation.location === location) {
			const answer = latestAnswer(messages, pendingConfirmation.createdAt);
			if (answer && AFFIRMATIVE.test(String(answer.text ?? ''))) {
				grant = {
					category: risk.category,
					location,
					expiresAt: timestamp + confirmationTtlMs,
					remainingUses: DEFAULT_CONFIRMATION_USES - 1
				};
				pendingConfirmation = undefined;
				return { allowed: true, confirmationUsed: true, category: risk.category };
			}
			if (answer && NEGATIVE.test(String(answer.text ?? ''))) {
				pendingConfirmation = undefined;
				return blocked(
					BROWSER_POLICY_CODES.CONFIRMATION_DECLINED,
					`The user declined the ${risk.category} action. Do not execute or retry it.`,
					{ requiresConfirmation: false }
				);
			}
		}

		pendingConfirmation = {
			id: randomUUID(),
			category: risk.category,
			action,
			target: risk.label.slice(0, 240),
			location,
			createdAt: timestamp,
			expiresAt: timestamp + confirmationTtlMs
		};
		return blocked(
			BROWSER_POLICY_CODES.CONFIRMATION_REQUIRED,
			`Browser safety did not execute the potentially destructive ${risk.category} action “${pendingConfirmation.target}”. Call ask_question, name this exact action, and wait for explicit user confirmation before retrying.`,
			{
				requiresConfirmation: true,
				confirmation: { ...pendingConfirmation }
			}
		);
	}

	return {
		isProduction: production,
		evaluateNavigation: input => evaluate(input, { topLevel: true }),
		evaluateRequest: (input, options) => evaluate(input, options),
		async allowObservedMeetingLink(input, sourceUrl) {
			const source = await evaluate(sourceUrl, { topLevel: true });
			if (!source.allowed) return source;
			const regular = await evaluate(input, { topLevel: true });
			if (regular.allowed || regular.code !== BROWSER_POLICY_CODES.OUT_OF_SCOPE_NAVIGATION) return regular;
			if (!isRecognizedMeetingUrl(input)) return blocked(BROWSER_POLICY_CODES.MEETING_LINK_NOT_SUPPORTED,
				'This external link is outside the target scope and is not a recognized HTTPS meeting entry link. Configure its trusted origin to test it.');
			const parsed = parseDestination(input);
			const destination = await validatePublicDestination(parsed.url);
			if (!destination.allowed) return destination;
			if (observedMeetingLinks.size >= 50) return blocked(BROWSER_POLICY_CODES.MEETING_LINK_NOT_SUPPORTED, 'The run has reached its observed meeting link limit.');
			observedMeetingLinks.add(meetingDestinationKey(parsed.url));
			return destination;
		},
		authorizeAction,
		asBlockedResult,
		getPendingConfirmation: () => pendingConfirmation && { ...pendingConfirmation }
	};
}

export { asBlockedResult };
