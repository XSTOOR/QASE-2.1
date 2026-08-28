/**
 * Mobile DOM audit — deterministic, bounded, DOM-only.
 *
 * Runs a single page.evaluate() per call and returns three provable signals
 * that mobile users actually feel:
 *
 *  1. Missing or wrong <meta name="viewport"> (no meta, or user-scalable=no,
 *     or a fixed pixel width). Without this the site is not really responsive;
 *     it is scaled down.
 *  2. Horizontal overflow beyond the viewport (documentElement.scrollWidth >
 *     window.innerWidth by more than 1px). This is what makes a user swipe
 *     sideways on a phone.
 *  3. Interactive elements smaller than the WCAG 2.5.5 / Apple HIG 44 CSS px
 *     tap-target minimum. Anything smaller is a real usability defect on
 *     touch.
 *
 * We do not attempt "hover-only menu" detection here because it cannot be
 * proven from the DOM alone without triggering interactions on the target
 * site. Report what we can prove, and let the agent's own workflow surface
 * the rest as regular findings.
 */

const AUDIT_BROWSER = (limit) => {
	const results = { viewport: {}, overflow: {}, tapTargets: [] };
	const meta = document.querySelector('meta[name="viewport"]');
	const content = meta?.getAttribute('content') ?? '';
	results.viewport = {
		present: Boolean(meta),
		content,
		userScalable: !/user-scalable\s*=\s*no/i.test(content) && !/maximum-scale\s*=\s*1(\.0+)?\b/i.test(content),
		widthDeviceWidth: /width\s*=\s*device-width/i.test(content)
	};
	const clientWidth = window.innerWidth;
	const scrollWidth = document.documentElement.scrollWidth;
	results.overflow = {
		clientWidth,
		scrollWidth,
		overflowsBy: Math.max(0, scrollWidth - clientWidth)
	};
	const MIN = 44;
	const nodes = Array.from(document.querySelectorAll('a[href], button, [role=button], input:not([type=hidden]), select, textarea, [onclick], [tabindex]:not([tabindex="-1"])'));
	const seen = new Set();
	for (const node of nodes) {
		if (results.tapTargets.length >= limit) break;
		const rect = node.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) continue;
		if (rect.width >= MIN && rect.height >= MIN) continue;
		const style = window.getComputedStyle(node);
		if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') continue;
		const label = (node.getAttribute('aria-label') || node.getAttribute('title') || node.innerText || node.value || node.tagName).toString().trim().slice(0, 80);
		const selectorKey = node.tagName + ':' + label + ':' + Math.round(rect.width) + 'x' + Math.round(rect.height);
		if (seen.has(selectorKey)) continue;
		seen.add(selectorKey);
		results.tapTargets.push({
			tag: node.tagName.toLowerCase(),
			label,
			width: Math.round(rect.width),
			height: Math.round(rect.height),
			role: node.getAttribute('role') ?? undefined
		});
	}
	return results;
};

/**
 * Turn the raw audit into a bounded, engineer-readable summary the agent can
 * treat as evidence. Returns undefined when nothing actionable is found so
 * the diagnostics payload does not swell with empty sections.
 */
export function summarizeMobileAudit(raw) {
	if (!raw) return undefined;
	const problems = [];
	if (!raw.viewport?.present) {
		problems.push({ kind: 'viewport_missing', message: 'No <meta name="viewport"> — the page will render at desktop width and be scaled down on phones.' });
	} else {
		if (!raw.viewport.widthDeviceWidth) {
			problems.push({ kind: 'viewport_not_device_width', message: 'Viewport meta does not set width=device-width; layout will not match the physical viewport.', content: raw.viewport.content });
		}
		if (!raw.viewport.userScalable) {
			problems.push({ kind: 'viewport_no_scaling', message: 'Viewport meta disables user scaling, which fails WCAG 1.4.4 for low-vision users.', content: raw.viewport.content });
		}
	}
	if (raw.overflow && raw.overflow.overflowsBy > 1) {
		problems.push({ kind: 'horizontal_overflow', message: 'Page content is wider than the viewport by ' + raw.overflow.overflowsBy + 'px — users will swipe sideways.', clientWidth: raw.overflow.clientWidth, scrollWidth: raw.overflow.scrollWidth });
	}
	const undersized = Array.isArray(raw.tapTargets) ? raw.tapTargets : [];
	if (undersized.length > 0) {
		problems.push({
			kind: 'small_tap_targets',
			message: undersized.length + ' interactive element(s) are below the 44×44 CSS-px minimum tap target size.',
			examples: undersized.slice(0, 5)
		});
	}
	if (problems.length === 0) return undefined;
	return { problems, viewport: raw.viewport, overflow: raw.overflow, undersizedCount: undersized.length };
}

/**
 * Run the audit against a live Playwright Page. Returns undefined on any
 * failure so the diagnostics call it augments never rejects because of us.
 */
export async function runMobileAudit(page, options = {}) {
	if (!page || typeof page.evaluate !== 'function') return undefined;
	const limit = Math.max(1, Math.min(200, Number(options.limit ?? 40)));
	try {
		const raw = await page.evaluate(AUDIT_BROWSER, limit);
		return summarizeMobileAudit(raw);
	} catch {
		return undefined;
	}
}
