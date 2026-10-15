/**
 * Authoritative system display timezone for QASE user-facing timestamps.
 *
 * One zone, resolved once per process (memoized per environment snapshot):
 *   QASE_DISPLAY_TIMEZONE (IANA name; default Asia/Kolkata)
 *
 * Every user-facing renderer of a feedback submission timestamp — the Telegram
 * notification, the markdown report, the PDF report, and the report tab —
 * formats through formatFeedbackTimestamp() so a submission made at 06:25 PM
 * IST reads 06:25 PM in every surface, regardless of the server's zone, the
 * viewer's browser zone, or delivery delay.
 */
const DEFAULT_DISPLAY_TIME_ZONE = 'Asia/Kolkata';

/** Valid IANA zone test — an invalid name throws from Intl. */
function isValidTimeZone(zone) {
	if (typeof zone !== 'string' || zone.trim() === '') return false;
	try {
		new Intl.DateTimeFormat('en', { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}

const zoneCache = new Map();

/**
 * Resolve the system display timezone from the environment snapshot.
 * Invalid/empty → documented default, with a one-time console.warn so the
 * misconfiguration is visible without breaking anything.
 */
export function resolveDisplayTimeZone(environment) {
	const raw = environment?.QASE_DISPLAY_TIMEZONE;
	const zone = typeof raw === 'string' ? raw.trim() : '';
	if (zone !== '' && isValidTimeZone(zone)) return zone;
	if (zone !== '' && !zoneCache.has(`warned:${zone}`)) {
		zoneCache.set(`warned:${zone}`, true);
		console.warn(`[qase] QASE_DISPLAY_TIMEZONE "${zone}" is not a valid IANA timezone; falling back to ${DEFAULT_DISPLAY_TIME_ZONE}.`);
	}
	return DEFAULT_DISPLAY_TIME_ZONE;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Short human label for a zone: Asia/Kolkata → "IST"; others → UTC offset. */
function zoneLabel(epochMs, zone) {
	if (zone === 'Asia/Kolkata') return 'IST';
	const offsetMinutes = timeZoneOffsetMinutes(epochMs, zone);
	if (offsetMinutes === 0) return 'UTC';
	const sign = offsetMinutes < 0 ? '-' : '+';
	const abs = Math.abs(offsetMinutes);
	const hours = String(Math.floor(abs / 60)).padStart(2, '0');
	const minutes = String(abs % 60).padStart(2, '0');
	return `UTC${sign}${hours}:${minutes}`;
}

function timeZoneOffsetMinutes(epochMs, zone) {
	const date = new Date(epochMs);
	const parts = new Intl.DateTimeFormat('en-GB', {
		timeZone: zone, hour12: false,
		year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', second: '2-digit'
	}).formatToParts(date);
	const get = type => Number(parts.find(part => part.type === type)?.value ?? 0);
	const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
	return Math.round((asUtc - date.getTime()) / 60000);
}

/**
 * Format an epoch-ms timestamp in the system display timezone:
 *   "13-Oct-2026 06:25 PM IST"
 * Locale-stable via an explicit Intl formatter (no environment locale drift).
 */
export function formatFeedbackTimestamp(epochMs, zone) {
	const validZone = isValidTimeZone(zone) ? zone : DEFAULT_DISPLAY_TIME_ZONE;
	if (!Number.isFinite(epochMs)) return '—';
	let parts;
	try {
		parts = new Intl.DateTimeFormat('en-GB', {
			timeZone: validZone, hour12: false,
			year: 'numeric', month: 'numeric', day: 'numeric',
			hour: '2-digit', minute: '2-digit'
		}).formatToParts(new Date(epochMs));
	} catch {
		parts = new Intl.DateTimeFormat('en-GB', {
			timeZone: DEFAULT_DISPLAY_TIME_ZONE, hour12: false,
			year: 'numeric', month: 'numeric', day: 'numeric',
			hour: '2-digit', minute: '2-digit'
		}).formatToParts(new Date(epochMs));
	}
	const get = type => Number(parts.find(part => part.type === type)?.value ?? 0);
	const hours24 = get('hour') % 24;
	const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
	const pad = value => String(value).padStart(2, '0');
	return `${pad(get('day'))}-${MONTHS[get('month') - 1]}-${get('year')} `
		+ `${pad(hours12)}:${pad(get('minute'))} ${hours24 < 12 ? 'AM' : 'PM'} ${zoneLabel(epochMs, validZone)}`;
}

/** True when the epoch is usable for display (guards the '—' path). */
export function hasValidTimestamp(epochMs) {
	return Number.isFinite(epochMs);
}
