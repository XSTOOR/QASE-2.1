// Small, explicitly synthetic catalog for browser layout/interaction checks.
export const launcherConfigurations = ['edge', 'chrome', 'brave'].map((browserCode, index) => ({
	envId: `fixture-${browserCode}`, platform: 'windows', platformLabel: 'Windows',
	manufacturer: 'Microsoft', device: 'Desktop', deviceType: 'desktop',
	os: 'Windows', osVersion: '11', orientation: 'landscape',
	browserCode, browser: ['Edge', 'Chrome', 'Brave'][index], browserVersion: '140',
	availability: 'AVAILABLE', availabilityReason: null, executionType: 'browser_emulation'
}));

export function launcherCatalog() {
	return {
		configurations: launcherConfigurations, index: launcherConfigurations,
		browserFamilies: launcherConfigurations.map(row => ({ code: row.browserCode, label: row.browser })),
		providers: [], totals: { configurations: launcherConfigurations.length }
	};
}
