import { checkEnvironmentHealth } from './environmentHealth.js';
import { preferredConfiguration } from '../public/singleRunSelection.js';

/** Choose a launch-checked desktop profile; never reuse a customer's stale selection. */
export async function chooseAutomaticBrowser(environments, { health = checkEnvironmentHealth, host = process.platform, probe = true } = {}) {
	const platforms = host === 'darwin' ? ['macos', 'windows'] : ['windows', 'macos'];
	const attempts = [];
	for (const browserCode of ['chrome']) {
		for (const platform of platforms) {
			const rows = await environments.list({ platform, browserCode, deviceType: 'desktop', active: true, limit: 80000 });
			const environment = preferredConfiguration(rows.filter(row => row.active !== false && row.deviceType === 'desktop' && !row.isRealDevice && row.browserSupport?.status !== 'not_supported'));
			if (!environment) continue;
			const report = probe ? await health(environment) : { verdict: 'READY' };
			if (probe) attempts.push({ browserCode, platform, verdict: report.verdict, reason: report.reason ?? null });
			if (report.verdict === 'READY') return { environment, selection: {
				mode: 'automatic', environmentId: environment.envId, browser: environment.browser ?? browserCode,
				browserCode, platform, phase: probe ? 'verified' : 'planned', executionType: environment.executionType, selectedAt: new Date().toISOString(), attempts
			} };
			// One default device and Chrome only; a failed launch does not fan out.
			break;
		}
	}
	// The health gate's own reason is the actionable truth ("Target
	// unreachable (http://…): timed out", "chromium engine failed to launch:
	// …"). Swallowing it behind a generic "Chrome could not start" blamed the
	// browser for the customer's own unreachable URL and sent them into a
	// retry loop with no way to know the URL was the problem (#18482).
	// Prefix the stable guidance, then surface the exact reason. The gate
	// prefixes each failed check with its name ("network: …") — useful in
	// technical logs, noise in a user-facing sentence, so strip it.
	const detail = attempts.find(attempt => attempt.reason)?.reason ?? null;
	const readable = detail
		? String(detail)
			.split(' | ')
			.map(part => part.replace(/^[a-z_]+:\s*/i, '').trim())
			.filter(Boolean)
			.join(' — ')
		: '';
	const message = readable
		? `The test could not start. ${readable} Your setup is preserved — fix the issue above (for example the website address) and start again.`
		: 'Chrome could not start on the default desktop. Your setup is preserved. Please try again shortly or contact support.';
	throw Object.assign(new Error(message), { code: 'AUTOMATIC_BROWSER_UNAVAILABLE' });
}
