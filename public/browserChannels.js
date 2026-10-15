/**
 * browserChannels — client mirror of the server release-channel ladders
 * (server/environmentCatalog.js channelForVersion, catalog 2027.02.0 #14420).
 *
 * Channel labels are DISPLAY METADATA derived from each browser's version
 * list POSITION — never hardcoded to a calendar-current number. When the
 * server catalog bumps its BROWSER_VERSIONS arrays, this mirror must be
 * bumped too (validate-matrix check 7b keeps the two in sync via its
 * static assertions on the server side; a follow-up can serve this from
 * /api/catalog/meta if drift ever bites).
 *
 * The full version arrays live here so buildBrowserColumns can window and
 * label versions even for majors the environments list doesn't carry yet.
 */

export const BROWSER_VERSIONS = Object.freeze({
	chrome: ['140', '141', '142', '143', '144', '145', '146', '147', '148', '149', '150', '151', '152', '153', '154', '155', '156'],
	firefox: ['141', '142', '143', '144', '145', '146', '147', '148', '149', '150', '151', '152', '153', '154', '155', '156', '157', '158'],
	edge: ['140', '141', '142', '143', '144', '145', '146', '147', '148', '149', '150', '151', '152', '153', '154', '155', '156'],
	opera: ['122', '123', '124', '125', '126', '127', '128', '129', '130', '131', '132', '133', '134', '135', '136', '137'],
	brave: ['136', '137', '138', '139', '140'],
	duckduckgo: ['1', '2', '3']
	// safari: version derives from the OS — no independent channel ladder.
});

export const BROWSER_CHANNELS = Object.freeze({
	safari: ['stable'],
	chrome: ['canary', 'dev', 'beta', 'stable'],
	firefox: ['nightly', 'beta', 'stable'],
	edge: ['canary', 'dev', 'beta', 'stable'],
	opera: ['beta', 'stable'],
	brave: ['nightly', 'beta', 'stable'],
	duckduckgo: ['stable']
});

/** Positional channel label; unknowns degrade to 'stable'. Mirrors the server. */
export function channelFor(browserCode, version) {
	const ladder = BROWSER_CHANNELS[browserCode];
	if (!ladder || ladder.length === 0) return 'stable';
	const versions = BROWSER_VERSIONS[browserCode];
	if (!versions) return 'stable';
	const index = versions.indexOf(String(version));
	if (index < 0) return 'stable';
	const distanceFromNewest = versions.length - 1 - index;
	if (distanceFromNewest < ladder.length - 1) return ladder[distanceFromNewest];
	return 'stable';
}
