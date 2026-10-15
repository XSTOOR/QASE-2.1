import { checkEnvironmentHealth } from './environmentHealth.js';

/** Choose a launch-checked desktop profile; never reuse a customer's stale selection. */
export async function chooseAutomaticBrowser(environments, { health = checkEnvironmentHealth, host = process.platform, probe = true } = {}) {
	const platforms = host === 'darwin' ? ['macos', 'windows'] : ['windows', 'macos'];
	const attempts = [];
	for (const browserCode of ['chrome', 'firefox', 'safari']) {
		for (const platform of platforms) {
			const rows = await environments.list({ platform, browserCode, deviceType: 'desktop', active: true, limit: 100 });
			const environment = rows.filter(row => row.active !== false && row.deviceType === 'desktop' && !row.isRealDevice && row.browserSupport?.status !== 'not_supported')
				.sort((a, b) => String(b.browserVersion ?? '').localeCompare(String(a.browserVersion ?? ''), 'en', { numeric: true })
					|| String(b.osVersion ?? '').localeCompare(String(a.osVersion ?? ''), 'en', { numeric: true }))[0];
			if (!environment) continue;
			const report = probe ? await health(environment) : { verdict: 'READY' };
			if (probe) attempts.push({ browserCode, platform, verdict: report.verdict });
			if (report.verdict === 'READY') return { environment, selection: {
				mode: 'automatic', environmentId: environment.envId, browser: environment.browser ?? browserCode,
				browserCode, platform, phase: probe ? 'verified' : 'planned', executionType: environment.executionType, selectedAt: new Date().toISOString(), attempts
			} };
		}
	}
	throw Object.assign(new Error('No browser can start on this server right now. Your setup is preserved. Please try again shortly or contact support.'), { code: 'AUTOMATIC_BROWSER_UNAVAILABLE' });
}
