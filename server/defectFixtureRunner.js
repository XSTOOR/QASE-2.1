/**
 * Known-defect fixture execution (#14650 NI02 Phase 2).
 *
 * Runs each registered fixture's DOM probe under a profile's real emulated
 * browser context (same Playwright path the agent uses) and records
 * reproduced = TRUE | FALSE | NOT_VERIFIED with evidence.
 *
 * Honesty rules:
 *   - NOT_VERIFIED whenever the page could not be loaded or evaluated
 *     (navigation error, probe exception, evaluate error). NEVER a guess.
 *   - Evidence is the raw probe payload; nothing is synthesized.
 *   - Expectation (fixture.affects) is recorded alongside the actual verdict
 *     so mismatches are visible, but the recorded `reproduced` value always
 *     reflects what the page actually showed.
 */

import { chromium, firefox, webkit } from 'playwright';
import { environmentEmulationOptions, engineForBrowser } from './browserstackProvider.js';

const ENGINE_LAUNCHERS = { chromium, firefox, webkit };

/** Verify a fixture against an environment snapshot. Returns a record; never throws for page-level failures. */
export async function verifyFixtureAgainstProfile({ fixture, environment, baseUrl, timeoutMs = 30_000 }) {
	if (!fixture) return { reproduced: 'NOT_VERIFIED', evidence: null, error: 'No fixture provided.' };
	if (!environment) return { reproduced: 'NOT_VERIFIED', evidence: null, error: 'No environment provided.' };

	const engine = engineForBrowser(environment.browserCode) ?? 'chromium';
	const launcher = ENGINE_LAUNCHERS[engine];
	if (!launcher) {
		return {
			reproduced: 'NOT_VERIFIED',
			evidence: null,
			error: `Engine "${engine}" has no local launcher; fixture not verified.`
		};
	}
	// Same emulation derivation the agent's launch path applies.
	const contextOptions = environmentEmulationOptions(environment) ?? {};

	const pageUrl = new URL(`/demo/defects/${fixture.id}`, baseUrl).toString();
	let browser = null;
	try {
		browser = await launcher.launch();
		const context = await browser.newContext({
			viewport: contextOptions.viewport ?? undefined,
			deviceScaleFactor: contextOptions.deviceScaleFactor ?? undefined,
			isMobile: contextOptions.isMobile ?? undefined,
			hasTouch: contextOptions.hasTouch ?? undefined
		});
		const page = await context.newPage();
		await page.goto(pageUrl, { waitUntil: 'load', timeout: timeoutMs });
		// Evaluate the fixture's own probe in the rendered page.
		const probe = await page.evaluate(new Function(`return (${fixture.verify})()`));
		if (!probe?.evaluated) {
			return {
				reproduced: 'NOT_VERIFIED',
				evidence: probe ?? null,
				error: 'Fixture probe could not evaluate its target elements.'
			};
		}
		return {
			reproduced: probe.reproduced ? 'TRUE' : 'FALSE',
			evidence: probe.evidence ?? null,
			error: null,
			url: pageUrl
		};
	} catch (error) {
		return {
			reproduced: 'NOT_VERIFIED',
			evidence: null,
			error: `Fixture verification failed: ${error instanceof Error ? error.message : String(error)}`
		};
	} finally {
		await browser?.close().catch(() => {});
	}
}
