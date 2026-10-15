import { promises as dns } from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { createBrowserPolicy } from './browserPolicy.js';

const TLS_PROBE_TIMEOUT_MS = 10_000;
const RECORD_FETCH_RETRIES = 3;
const RETRY_DELAY_MS = 120;

/**
 * External-reachability pre-flight for QA runs.
 *
 * Why this exists: the run container's resolver is split-horizon. Public
 * hostnames whose CNAME chain points at internal `*.prod.drytis.dev`
 * targets resolve to private pod IPs, and those endpoints serve
 * `*.drytis.dev` certificates. When a browser lands on such an endpoint
 * for a public hostname, certificate verification fails with
 * SSL_ERROR_BAD_CERT_DOMAIN even though the site is perfectly healthy
 * from the public internet. Chromium and Firefox follow CNAME chains
 * differently (Firefox more aggressively), which produced engine-
 * dependent "Secure Connection Failed" failures and a false CRITICAL
 * "site unreachable" finding.
 *
 */
export async function probeTargetReachability(rawUrl, options = {}) {
	let target;
	try {
		target = new URL(rawUrl);
	} catch {
		return { ok: false, unreachable: true, reason: 'invalid-url' };
	}
	if (target.protocol !== 'https:' && target.protocol !== 'http:') {
		return { ok: false, unreachable: true, reason: 'invalid-url' };
	}
	const host = target.hostname;
	const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
	let addresses;
	const resolveHost = async hostname => {
		addresses ??= await (options.resolveHost ?? (name => dns.lookup(name, { all: true })))(hostname);
		return addresses;
	};
	const policy = createBrowserPolicy({ getTargetUrl: () => rawUrl, environment: options.environment ?? process.env, resolveHost });
	const decision = await policy.evaluateNavigation(rawUrl);
	if (!decision.allowed) return { ok: false, unreachable: true, reason: decision.code === 'BROWSER_DNS_RESOLUTION_FAILED' ? 'dns-resolution-failed' : decision.code, detail: decision.message };
	if (!addresses) {
		const literal = host.replace(/^\[|\]$/g, '');
		addresses = net.isIP(literal) ? [{ address: literal }] : await resolveHost(host);
	}
	// Connect to the validated address, never perform a second DNS lookup.
	const systemIps = addresses.map(entry => typeof entry === 'string' ? entry : entry.address);
	if (!systemIps.length) return { ok: false, unreachable: true, reason: 'dns-resolution-failed' };

	if (target.protocol !== 'https:') {
		// Plain HTTP never triggers certificate checks; a connect probe is
		// enough signal for the report.
		const reachable = await (options.tcpProbe ?? tcpProbe)(systemIps[0], port);
		return reachable
			? { ok: true }
			: { ok: false, unreachable: true, reason: 'connection-refused-or-timeout' };
	}

	// HTTPS: resolve first so we can detect the split-horizon case before
	// attempting the handshake, and use the resolved IPv4 for the handshake
	// so the probe itself is not subject to browser-style CNAME chasing.

	// Check whether any resolved address sits in private/reserved space.
	let privateIps = systemIps.filter(isPrivateOrReserved);

	// Firefox resolves CNAME chains host-by-host, and an internal DNS zone
	// can hold a private record for a name deep in the chain (observed:
	// www.drytis.com -> ...prod.drytis.dev -> 10.x pod IP serving a
	// *.drytis.dev certificate). Chase the chain so the probe sees what
	// Firefox sees, not just what node's resolver returns for the apex.
	const chain = await chaseCnameChain(host);
	for (const hop of chain) {
		privateIps = privateIps.concat(hop.ips.filter(isPrivateOrReserved));
	}
	const isSplitHorizon = privateIps.length > 0;

	if (isSplitHorizon) {
		// The system resolver hands out an internal IP somewhere in the
		// resolution chain for a public hostname. Record the condition and
		// the evidence; the run proceeds but the report explains that any
		// certificate-mismatch or connection failure for this host is
		// environmental, not a defect of the site itself.
		return {
			ok: true,
			note: 'split-horizon-dns',
			detail:
				`The run environment resolves ${host} (or a name in its DNS chain) ` +
				`to a private address (${privateIps.join(', ')}). This happens when the ` +
				`target's CNAME chain points at infrastructure internal to the run ` +
				`environment. Any certificate-mismatch or connection failure for this ` +
				`host in this run is environmental, not a defect of the site itself.`,
			resolvedIps: systemIps
		};
	}

	// Public IP: verify the TLS handshake succeeds and the certificate is
	// valid for the hostname. `ok:false` here IS a site defect.
	const verified = await (options.tlsVerify ?? tlsVerify)(systemIps[0], port, host);
	return verified
		? { ok: true, resolvedIps: systemIps }
		: {
			ok: false,
			unreachable: true,
			reason: 'tls-certificate-invalid',
			detail: `TLS handshake failed or the certificate is not valid for ${host} from this environment.`,
			resolvedIps: systemIps
		};
}

async function resolveA(host) {
	for (let attempt = 0; attempt < RECORD_FETCH_RETRIES; attempt++) {
		try {
			const addresses = await dns.resolve4(host);
			if (addresses?.length) return addresses;
		} catch {
			// retry — transient resolver failures must not produce a false
			// "unreachable" verdict
		}
		await delay(RETRY_DELAY_MS);
	}
	return [];
}

/**
 * Resolve a hostname's full CNAME chain using resolveCname at each hop.
 * Returns [{ name, cname, ips }] for every alias hop that resolved.
 */
async function chaseCnameChain(host) {
	if (typeof __internals.chaseOverride === 'function') {
		return __internals.chaseOverride(host);
	}
	const hops = [];
	let current = host;
	const seen = new Set([host]);
	for (let depth = 0; depth < 5; depth++) {
		let cname;
		try {
			[cname] = await dns.resolveCname(current);
		} catch {
			break; // not a CNAME (or resolution failed) — chain ends
		}
		if (!cname || seen.has(cname)) break;
		seen.add(cname);
		const ips = await resolveA(cname);
		hops.push({ name: current, cname, ips });
		current = cname;
	}
	return hops;
}

function isPrivateOrReserved(ip) {
	if (!ip) return false;
	const parts = ip.split('.').map(Number);
	if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return false;
	const [a, b] = parts;
	if (a === 10 || a === 127) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 169 && b === 254) return true;
	if (a === 0 || a >= 224) return true;
	return false;
}

function tcpProbe(host, port) {
	return new Promise(resolve => {
		const socket = net.createConnection({ host, port });
		socket.setTimeout(TLS_PROBE_TIMEOUT_MS, () => { socket.destroy(); resolve(false); });
		socket.on('connect', () => { socket.destroy(); resolve(true); });
		socket.on('error', () => resolve(false));
	});
}

function tlsVerify(ip, port, servername) {
	return new Promise(resolve => {
		const socket = tls.connect(
			{ host: ip, port, servername, rejectUnauthorized: true, timeout: TLS_PROBE_TIMEOUT_MS },
			() => {
				const cert = socket.getPeerCertificate();
				socket.destroy();
				resolve(Boolean(cert && cert !== true));
			}
		);
		socket.on('error', () => resolve(false));
		socket.on('timeout', () => { socket.destroy(); resolve(false); });
	});
}

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** Exposed for tests. */
export const __internals = { isPrivateOrReserved, chaseOverride: undefined };
