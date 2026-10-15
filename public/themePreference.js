/**
 * themePreference — Dark / Light / System-default theme selection (#14383).
 *
 * Three user-visible options map to one persisted preference under
 * 'qase.theme': 'dark' | 'light' | 'system'. The APPLIED theme is always a
 * concrete value ('dark' | 'light') set on <html data-theme> so the CSS token
 * layers never need their own prefers-color-scheme branching — this module
 * resolves 'system' via matchMedia and follows OS changes live.
 *
 * Persistence follows the qase.* localStorage convention with an injectable
 * storage (see activeTestEnvironment.js). All reads/writes are guarded:
 * storage unavailable (private mode) degrades to a session-only theme.
 */

const THEME_KEY = 'qase.theme';
export const THEME_PREFERENCES = Object.freeze(['dark', 'light', 'system']);
export const DEFAULT_THEME = 'system';

/** Missing or invalid preferences follow the system, matching theme.js. */
export function normalizeThemePreference(value) {
	if (typeof value !== 'string') return DEFAULT_THEME;
	const candidate = value.trim().toLowerCase();
	return THEME_PREFERENCES.includes(candidate) ? candidate : DEFAULT_THEME;
}

function readStoredTheme(storage) {
	try {
		return storage?.getItem?.(THEME_KEY) ?? null;
	} catch {
		return null;
	}
}

/**
 * Resolves the concrete applied theme ('dark' | 'light') from a preference.
 * 'system' consults matchMedia — missing matchMedia (ancient browsers, tests)
 * resolves dark, the default and the historical appearance of this app.
 */
export function resolveAppliedTheme(preference, matchMedia = globalThis.matchMedia) {
	if (preference === 'light') return 'light';
	if (preference === 'dark') return 'dark';
	// 'system' (or unknown): consult the OS. matchMedia missing/unusable or a
	// thrown query resolves dark — the default and historical appearance.
	try {
		if (typeof matchMedia !== 'function') return 'dark';
		const query = matchMedia('(prefers-color-scheme: dark)');
		return query?.matches ? 'dark' : 'light';
	} catch {
		return 'dark';
	}
}

export function createThemeStore({ storage = globalThis.localStorage, matchMedia = globalThis.matchMedia, onChange = () => {} } = {}) {
	let preference = normalizeThemePreference(readStoredTheme(storage));
	let applied = resolveAppliedTheme(preference, matchMedia);
	let unsubscribe = null;

	if (preference === 'system') {
		try {
			const query = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
			if (query?.addEventListener) {
				const listener = () => {
					applied = resolveAppliedTheme('system', matchMedia);
					onChange({ preference, applied });
				};
				query.addEventListener('change', listener);
				unsubscribe = () => query.removeEventListener('change', listener);
			}
		} catch {
			/* live tracking unavailable — snapshot resolution stands */
		}
	}

	return {
		preference() { return preference; },
		applied() { return applied; },
		/** Persist + apply a new preference. Invalid input is normalized, never thrown. */
		set(next) {
			preference = normalizeThemePreference(next);
			try {
				storage?.setItem?.(THEME_KEY, preference);
			} catch {
				/* session-only */
			}
			if (unsubscribe) { unsubscribe(); unsubscribe = null; }
			if (preference === 'system') {
				try {
					const query = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
					if (query?.addEventListener) {
						const listener = () => {
							applied = resolveAppliedTheme('system', matchMedia);
							onChange({ preference, applied });
						};
						query.addEventListener('change', listener);
					 unsubscribe = () => query.removeEventListener('change', listener);
					}
				} catch { /* ignore */ }
			}
			applied = resolveAppliedTheme(preference, matchMedia);
			onChange({ preference, applied });
		},
		/** Detach the OS-preference listener (tests, teardown). */
		dispose() {
			if (unsubscribe) { unsubscribe(); unsubscribe = null; }
		}
	};
}

/**
 * Applies a concrete theme to the document root. Idempotent, safe pre-DOM.
 */
export function applyThemeToDocument(documentObj = globalThis.document, applied) {
	const value = applied === 'light' ? 'light' : 'dark';
	const root = documentObj?.documentElement;
	if (!root) return value;
	root.dataset.theme = value;
	return value;
}
