import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	THEME_PREFERENCES,
	DEFAULT_THEME,
	normalizeThemePreference,
	resolveAppliedTheme,
	createThemeStore,
	applyThemeToDocument
} from './themePreference.js';

/** localStorage fake matching the shape used by activeTestEnvironment tests. */
function memoryStorage(initial = {}) {
	const map = new Map(Object.entries(initial));
	return {
		getItem: (k) => (map.has(k) ? map.get(k) : null),
		setItem: (k, v) => { map.set(String(k), String(v)); },
		removeItem: (k) => { map.delete(k); },
		dump: () => Object.fromEntries(map)
	};
}

/** matchMedia fake with a mutable OS preference. */
function fakeMatchMedia(osPrefersDark) {
	const listeners = new Set();
	let dark = osPrefersDark;
	return Object.assign(function (query) {
		assert.equal(query, '(prefers-color-scheme: dark)');
		return {
			get matches() { return dark; },
			addEventListener: (_type, listener) => listeners.add(listener),
			removeEventListener: (_type, listener) => listeners.delete(listener)
		};
	}, {
		setOsPrefersDark(value) {
			dark = value;
			for (const listener of listeners) listener();
		},
		listenerCount: () => listeners.size
	});
}

// ---------------------------------------------------------------------------
// normalizeThemePreference — resolution matrix
// ---------------------------------------------------------------------------

test('normalizeThemePreference accepts the three valid values verbatim', () => {
	assert.equal(normalizeThemePreference('dark'), 'dark');
	assert.equal(normalizeThemePreference('light'), 'light');
	assert.equal(normalizeThemePreference('system'), 'system');
});

test('normalizeThemePreference normalizes case and whitespace', () => {
	assert.equal(normalizeThemePreference(' Light '), 'light');
	assert.equal(normalizeThemePreference('DARK'), 'dark');
	assert.equal(normalizeThemePreference('\tsystem\n'), 'system');
});

test('normalizeThemePreference follows the system for missing/invalid values', () => {
	assert.equal(normalizeThemePreference(null), 'system');
	assert.equal(normalizeThemePreference(undefined), 'system');
	assert.equal(normalizeThemePreference(''), 'system');
	assert.equal(normalizeThemePreference('banana'), 'system');
	assert.equal(normalizeThemePreference(''), DEFAULT_THEME);
	assert.equal(DEFAULT_THEME, 'system');
});

test('THEME_PREFERENCES exposes exactly the three user options', () => {
	assert.deepEqual([...THEME_PREFERENCES], ['dark', 'light', 'system']);
});

// ---------------------------------------------------------------------------
// resolveAppliedTheme
// ---------------------------------------------------------------------------

test('resolveAppliedTheme maps dark/light directly', () => {
	assert.equal(resolveAppliedTheme('dark', fakeMatchMedia(true)), 'dark');
	assert.equal(resolveAppliedTheme('light', fakeMatchMedia(true)), 'light'); // even when OS is dark
});

test("resolveAppliedTheme follows the OS for 'system'", () => {
	assert.equal(resolveAppliedTheme('system', fakeMatchMedia(true)), 'dark');
	assert.equal(resolveAppliedTheme('system', fakeMatchMedia(false)), 'light');
});

test('resolveAppliedTheme defaults dark when matchMedia is unavailable', () => {
	assert.equal(resolveAppliedTheme('system', null), 'dark');
	assert.equal(resolveAppliedTheme('system', undefined), 'dark');
});

// ---------------------------------------------------------------------------
// createThemeStore — persistence + live system tracking
// ---------------------------------------------------------------------------

test('store follows the system with no stored preference', () => {
	const storage = memoryStorage();
	const store = createThemeStore({ storage, matchMedia: fakeMatchMedia(false) });
	assert.equal(store.preference(), 'system');
	assert.equal(store.applied(), 'light');
	store.dispose();
});

test('store restores each persisted preference and resolves system against the OS', () => {
	for (const [stored, osDark, expectedPreference, expectedApplied] of [
		['dark', true, 'dark', 'dark'],
		['dark', false, 'dark', 'dark'],
		['light', true, 'light', 'light'],
		['light', false, 'light', 'light'],
		['system', true, 'system', 'dark'],
		['system', false, 'system', 'light']
	]) {
		const storage = memoryStorage({ 'qase.theme': stored });
		const store = createThemeStore({ storage, matchMedia: fakeMatchMedia(osDark) });
		assert.equal(store.preference(), expectedPreference, `preference for stored=${stored}`);
		assert.equal(store.applied(), expectedApplied, `applied for stored=${stored} osDark=${osDark}`);
		store.dispose();
	}
});

test('invalid stored value follows the system', () => {
	const storage = memoryStorage({ 'qase.theme': 'neon' });
	const store = createThemeStore({ storage, matchMedia: fakeMatchMedia(false) });
	assert.equal(store.preference(), 'system');
	assert.equal(store.applied(), 'light');
	store.dispose();
});

test('set() persists the preference and updates applied immediately', () => {
	const storage = memoryStorage();
	const store = createThemeStore({ storage, matchMedia: fakeMatchMedia(false) });
	store.set('light');
	assert.equal(storage.dump()['qase.theme'], 'light');
	assert.equal(store.applied(), 'light');
	store.set('dark');
	assert.equal(storage.dump()['qase.theme'], 'dark');
	assert.equal(store.applied(), 'dark');
	store.set('garbage'); // normalized, never thrown
	assert.equal(storage.dump()['qase.theme'], 'system');
	store.dispose();
});

test('set() notifies onChange with preference and applied', () => {
	const events = [];
	const store = createThemeStore({ storage: memoryStorage(), matchMedia: fakeMatchMedia(false), onChange: (e) => events.push({ ...e }) });
	store.set('light');
	assert.deepEqual(events.at(-1), { preference: 'light', applied: 'light' });
	store.dispose();
});

test("system preference tracks OS changes live while the page is open", () => {
	const events = [];
	const matchMedia = fakeMatchMedia(true);
	const store = createThemeStore({ storage: memoryStorage({ 'qase.theme': 'system' }), matchMedia, onChange: (e) => events.push({ ...e }) });
	assert.equal(store.applied(), 'dark');
	matchMedia.setOsPrefersDark(false);
	assert.equal(store.applied(), 'light', 'flips without reload when the OS changes');
	assert.deepEqual(events.at(-1), { preference: 'system', applied: 'light' });
	matchMedia.setOsPrefersDark(true);
	assert.equal(store.applied(), 'dark');
	store.dispose();
	assert.equal(matchMedia.listenerCount(), 0, 'listener detached on dispose');
});

test('switching to a fixed theme unsubscribes from OS changes', () => {
	const matchMedia = fakeMatchMedia(true);
	const store = createThemeStore({ storage: memoryStorage({ 'qase.theme': 'system' }), matchMedia });
	assert.equal(matchMedia.listenerCount(), 1);
	store.set('dark');
	assert.equal(matchMedia.listenerCount(), 0, 'no live tracking once preference is fixed');
	store.dispose();
});

test('switching to system subscribes to OS changes', () => {
	const matchMedia = fakeMatchMedia(false);
	const store = createThemeStore({ storage: memoryStorage({ 'qase.theme': 'dark' }), matchMedia });
	assert.equal(matchMedia.listenerCount(), 0);
	store.set('system');
	assert.equal(matchMedia.listenerCount(), 1);
	store.dispose();
});

test('storage write failures degrade to session-only theming (no throw)', () => {
	const broken = {
		getItem: () => { throw new Error('denied'); },
		setItem: () => { throw new Error('denied'); },
		removeItem: () => {}
	};
	const store = createThemeStore({ storage: broken, matchMedia: fakeMatchMedia(false) });
	assert.equal(store.preference(), 'system'); // read failure → default, no throw
	store.set('light');
	assert.equal(store.applied(), 'light'); // applies for the session despite persistence failure
	store.dispose();
});

test('missing storage (null) does not throw', () => {
	const store = createThemeStore({ storage: null, matchMedia: fakeMatchMedia(true) });
	assert.equal(store.preference(), 'system');
	assert.equal(store.applied(), 'dark');
	store.set('light');
	assert.equal(store.applied(), 'light');
	store.dispose();
});

// ---------------------------------------------------------------------------
// applyThemeToDocument
// ---------------------------------------------------------------------------

test('applyThemeToDocument sets data-theme on the root element and returns the value', () => {
	const root = { dataset: {} };
	const documentObj = { documentElement: root };
	assert.equal(applyThemeToDocument(documentObj, 'light'), 'light');
	assert.equal(root.dataset.theme, 'light');
	assert.equal(applyThemeToDocument(documentObj, 'dark'), 'dark');
	assert.equal(root.dataset.theme, 'dark');
});

test('applyThemeToDocument coerces unknown input to dark and is safe without a document', () => {
	const root = { dataset: {} };
	applyThemeToDocument({ documentElement: root }, 'banana');
	assert.equal(root.dataset.theme, 'dark');
	assert.equal(applyThemeToDocument(null, 'light'), 'light'); // no throw pre-DOM
});
