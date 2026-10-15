import https from 'node:https';
import { createOperationalLogger } from './operationalLogger.js';

const ACTIVE_STATUSES = new Set(['running', 'awaiting_input']);

/**
 * Self-keepalive for containerized deployments.
 *
 * Workspace containers pause after an inbound-traffic idle window. During an
 * agent run the server is busy (LLM streaming, Chromium automation) but
 * receives almost no inbound HTTP requests, so the platform can pause the
 * container mid-run; the subsequent resume restarts the process and the run
 * is lost (marked `interrupted` by the run store on load).
 *
 * While at least one run is active, the server pings its own /healthz over
 * the PUBLIC site URL on a fixed interval, which counts as edge traffic and
 * keeps the container awake. A short hysteresis window after the last active
 * run avoids start/stop churn for back-to-back runs.
 *
 * IMPORTANT: inside the container, the platform's DNS resolves the public site
 * hostname via split-horizon to the CLUSTER-INTERNAL service IP. A fetch of
 * https://site/healthz then hairpins through the cluster and never traverses
 * the platform edge, so it cannot reset the idle timer (this is exactly why
 * v2 keepalive failed). The keepalive therefore resolves the hostname's true
 * public A record over DNS-over-HTTPS and connects to that IP while keeping
 * the TLS SNI + Host header on the real hostname, so the edge observes a
 * normal, well-formed request.
 */

const DOH_URL = 'https://dns.google/resolve?name=';
const PUBLIC_IP_RESOLVE_INTERVAL_MS = 10 * 60_000;
const PUBLIC_IP_RETRY_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** Extract the hostname from a URL; null when not parseable. */
export function hostnameOf(url) {
	try {
		return new URL(url).hostname || null;
	} catch {
		return null;
	}
}

/**
 * Resolve the true public A record for a hostname via DNS-over-HTTPS.
 * Cluster-internal answers are invisible here because dns.google is queried
 * over the public internet and returns the edge A record.
 */
export async function resolvePublicIp(hostname, { fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	timer.unref?.();
	try {
		const response = await fetchImpl(`${DOH_URL}${encodeURIComponent(hostname)}&type=A`, {
			signal: controller.signal,
			headers: { accept: 'application/dns-json' }
		});
		if (!response?.ok) return null;
		const payload = await response.json();
		const answer = Array.isArray(payload?.Answer)
			? payload.Answer.find(entry => entry.type === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(String(entry.data)))
			: undefined;
		return answer ? String(answer.data) : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Issue an HTTPS GET to `https://<ip>/healthz` with SNI and Host pinned to the
 * real hostname, so the request traverses the public edge and terminates on
 * this deployment like any user request. Resolves with the response status.
 */
export function requestViaPublicIp({ ip, hostname, path = '/healthz', timeoutMs = REQUEST_TIMEOUT_MS, agent }) {
	return new Promise((resolve, reject) => {
		const request = https.request({
			host: ip,
			servername: hostname,
			headers: { host: hostname, 'user-agent': 'qase-keepalive' },
			path,
			timeout: timeoutMs,
			agent
		}, response => {
			response.resume();
			resolve(response?.statusCode ?? 0);
		});
		request.on('timeout', () => {
			request.destroy(new Error(`Keepalive request timed out after ${timeoutMs}ms.`));
		});
		request.on('error', reject);
		request.end();
	});
}

export function createRunKeepalive(options = {}) {
	const intervalMs = options.intervalMs ?? 60_000;
	const quietAfterMs = options.quietAfterMs ?? 120_000;
	const getUrl = options.getUrl ?? (() => null);
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const logger = options.logger ?? createOperationalLogger({ component: 'qase-keepalive' });
	// Optional predicate: while it returns true the keepalive keeps pinging even
	// if no run-bus event arrived recently (a run can stream nothing for minutes
	// during one long model generation — that must NOT disarm the keepalive).
	const isActive = typeof options.isActive === 'function' ? options.isActive : null;

	let timer = null;
	let lastActiveAt = 0;
	let stopped = false;
	// Resolved public edge IP for the site host, with the time it was obtained.
	let publicIp = null;
	let publicIpResolvedAt = 0;
	let publicIpLookup = null;
	// Keep one connection pool per keepalive; keepAlive avoids TLS handshake
	// churn on every ping while still letting sockets close on stop().
	let httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 2 });
	httpsAgent.on('error', () => { /* socket-level errors surface per request */ });

	const hostname = () => hostnameOf(getUrl() ?? '');

	/** Ensure the public edge IP is known; refreshes periodically. Never throws. */
	async function ensurePublicIp() {
		const host = hostname();
		if (!host) return null;
		const now = Date.now();
		if (publicIp && now - publicIpResolvedAt < PUBLIC_IP_RESOLVE_INTERVAL_MS) {
			return publicIp;
		}
		if (publicIpLookup) return publicIpLookup;
		publicIpLookup = (async () => {
			const ip = await resolvePublicIp(host, { fetchImpl });
			publicIpLookup = null;
			if (ip) {
				publicIp = ip;
				publicIpResolvedAt = Date.now();
				return ip;
			}
			// Retry DoH soon rather than after the full refresh interval.
			publicIpResolvedAt = now - (PUBLIC_IP_RESOLVE_INTERVAL_MS - PUBLIC_IP_RETRY_INTERVAL_MS);
			return null;
		})();
		return publicIpLookup;
	}

	async function ping(url, host, ip) {
		if (ip) {
			const status = await requestViaPublicIp({ ip, hostname: host, agent: httpsAgent });
			logger.info('keepalive.ping.ok', { status, url, ip });
			return;
		}
		// No DoH answer (offline / blocked): fall back to the plain URL. It may
		// hairpin internally, but it still exercises the local server and keeps
		// this component observable rather than silently dead.
		const response = await fetchImpl(url, { headers: { 'user-agent': 'qase-keepalive' } });
		logger.info('keepalive.ping.ok', { status: response?.status ?? 'unknown', url });
	}

	async function tickAsync() {
		const url = getUrl();
		if (!url) return;
		const host = hostname();
		const ip = host ? await ensurePublicIp() : null;
		await ping(url, host, ip);
	}

	function tick() {
		const recentlyActive = lastActiveAt > 0 && Date.now() - lastActiveAt < quietAfterMs;
		if (!recentlyActive && isActive?.()) {
			// A live run exists even though the bus has been quiet (long model
			// generation): treat it as activity.
			lastActiveAt = Date.now();
		}
		const active = lastActiveAt > 0 && Date.now() - lastActiveAt < quietAfterMs;
		if (!active) {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
			return;
		}
		tickAsync().catch(error => {
			// The keepalive must never take the process down; a failed
			// self-ping is retried on the next tick.
			logger.warn('keepalive.ping.failed', {
				errorName: error?.name ?? 'UnknownError',
				url: getUrl()
			});
		});
	}

	return {
		/** Call whenever a run is (or may be) active. */
		noteActive() {
			if (stopped) return;
			const starting = !timer;
			lastActiveAt = Date.now();
			if (!timer) {
				timer = setInterval(tick, intervalMs);
				timer.unref?.();
			}
			if (starting) {
				// Observable proof in the service log that the keepalive armed.
				logger.info('keepalive.started', {
					intervalMs,
					quietAfterMs,
					url: getUrl()
				});
			}
		},
		/** True while pings are being sent (for diagnostics). */
		isPinging() {
			return Boolean(timer);
		},
		/** The currently resolved public edge IP, for diagnostics. */
		getPublicIp() {
			return publicIp;
		},
		/** Stop permanently and clear the timer. */
		stop() {
			stopped = true;
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
			httpsAgent.destroy();
		}
	};
}

/** True when a run status means the agent loop is in flight or paused on input. */
export function isRunStatusActive(status) {
	return ACTIVE_STATUSES.has(status);
}
