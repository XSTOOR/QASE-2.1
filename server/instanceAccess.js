const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function requestOrigin(request) {
	return `${request.protocol}://${request.get('host')}`;
}

function isSameOrigin(request) {
	if (request.get('sec-fetch-site') === 'cross-site') return false;
	if (SAFE_METHODS.has(request.method)) return true;
	const origin = request.get('origin');
	if (!origin) return true;
	try {
		return new URL(origin).origin === requestOrigin(request);
	} catch {
		return false;
	}
}

function trustedOwner(tenantContext) {
	if (!tenantContext || typeof tenantContext !== 'object' || Array.isArray(tenantContext)) {
		throw new TypeError('Embedded instance access requires a trusted tenant context.');
	}
	for (const key of ['organizationId', 'projectId', 'actorUserId', 'actorEmail', 'actorName']) {
		if (typeof tenantContext[key] !== 'string' || tenantContext[key].trim() === '') {
			throw new TypeError(`Embedded instance access requires tenantContext.${key}.`);
		}
	}
	return Object.freeze({
		organizationId: tenantContext.organizationId,
		projectId: tenantContext.projectId,
		actorUserId: tenantContext.actorUserId,
		email: tenantContext.actorEmail,
		displayName: tenantContext.actorName,
		role: 'owner'
	});
}

/** Security headers shared by the API, worker probe and heartbeat probe. */
export function securityHeaders(request, response, next) {
	const demo = request.app?.locals?.qaseDemoEnabled !== false
		&& (request.path === '/demo' || request.path.startsWith('/demo/'));
	const scriptPolicy = demo ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'";
	const configuredAncestors = request.app?.locals?.qaseFrameAncestors;
	const frameAncestors = Array.isArray(configuredAncestors) && configuredAncestors.length > 0
		? configuredAncestors.join(' ')
		: "'none'";
	response.set({
		'Content-Security-Policy': `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; ${scriptPolicy}; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors ${frameAncestors}; form-action 'self'`,
		'Cross-Origin-Opener-Policy': 'same-origin',
		'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff'
	});
	// X-Frame-Options has no interoperable exact-origin allowlist. CSP
	// frame-ancestors is authoritative when a reviewed Drytis origin is enabled.
	if (frameAncestors === "'none'") response.set('X-Frame-Options', 'DENY');
	if (request.secure) {
		response.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	}
	next();
}

/**
 * Browser access boundary for one Drytis-owned Qase process.
 *
 * Drytis authenticates the user and routes them to their own instance. Qase
 * therefore has no second login or session lifecycle; it accepts only
 * same-origin browser API requests and attributes every action to the trusted,
 * process-configured owner. Tenant or actor identity is never read from the
 * request. The service must remain behind Drytis's authenticated instance
 * routing; the origin guard is not a replacement for that network boundary.
 */
export function createInstanceAccess({ tenantContext } = {}) {
	const owner = trustedOwner(tenantContext);

	function mount(app) {
		if (!app || typeof app.use !== 'function') {
			throw new TypeError('Embedded instance access requires an Express application.');
		}
		app.use('/api', (request, response, next) => {
			response.set('Cache-Control', 'no-store');
			if (!isSameOrigin(request)) {
				response.status(403).json({ error: 'Cross-origin request rejected.' });
				return;
			}
			request.auth = owner;
			next();
		});
	}

	return Object.freeze({ mount });
}
