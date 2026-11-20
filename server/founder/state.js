/**
 * Persistence helpers for Founder runs. Engine runs (version 2) are stored as
 * they are. Runs made by the previous Founder pipeline are kept untouched and
 * shown read-only.
 */
export const MAX_FOUNDER_STATE_BYTES = 1_000_000;

export function normalizeFounderState(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
	return input;
}
