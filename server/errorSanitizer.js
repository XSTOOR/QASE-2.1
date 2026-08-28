const SECRET_ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|cookie|set-cookie)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const BEARER = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const URL_WITH_PRIVATE_PARTS = /https?:\/\/[^\s<>'"]+/gi;
const PRIVATE_KEY = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi;

function safeUrl(candidate) {
	try {
		const url = new URL(candidate);
		url.username = '';
		url.password = '';
		url.search = '';
		url.hash = '';
		return url.toString();
	} catch {
		return '[redacted-url]';
	}
}

/** Convert an external/runtime error into bounded, non-secret diagnostic text. */
export function sanitizeErrorDetail(error, maximum = 1_000) {
	const limit = Number.isSafeInteger(maximum) && maximum >= 100 && maximum <= 2_000 ? maximum : 1_000;
	let value = error instanceof Error ? error.message : String(error ?? 'Operation failed.');
	value = value
		.replace(PRIVATE_KEY, '[redacted-private-key]')
		.replace(BEARER, '[redacted-authorization]')
		// Authorization assignments frequently start with "Bearer" or "Basic".
		// Remove the complete credential before the generic assignment matcher can
		// consume only the scheme and leave the token behind.
		.replace(SECRET_ASSIGNMENT, (_match, key) => `${key}=[redacted]`)
		.replace(URL_WITH_PRIVATE_PARTS, safeUrl)
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!value) value = 'Operation failed.';
	return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
