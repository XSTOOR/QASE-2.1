/**
 * Page-level detectors: layout, overlap, clipping, overflow, accessibility,
 * content, console, network and performance. One call audits one page in one
 * viewport, scrolling through it so below-the-fold content is measured too.
 */
import { candidate } from '../findings.js';
import { pageAudit } from './pageAudit.js';

const CATEGORY = {
	text_overlap: 'layout', control_obscured: 'layout', text_obscured: 'layout', text_clipped: 'layout', text_overflow_box: 'layout',
	horizontal_overflow: 'responsive', blocking_overlay: 'layout', small_touch_targets: 'accessibility', broken_image: 'content',
	distorted_image: 'visual', image_alt_missing: 'accessibility', control_no_name: 'accessibility', field_no_label: 'accessibility',
	missing_lang: 'accessibility', zoom_disabled: 'accessibility', viewport_meta_missing: 'responsive', duplicate_ids: 'accessibility',
	low_contrast: 'accessibility', broken_text: 'content', placeholder_copy: 'content', blank_page: 'functional', missing_title: 'seo',
	missing_h1: 'seo', broken_anchor: 'navigation', hidden_content: 'animation',
	invalid_nesting: 'dom', form_in_form: 'dom', orphan_list_item: 'dom', broken_aria_reference: 'dom', aria_hidden_focusable: 'dom', invalid_role: 'dom', excessive_dom: 'dom'
};

/** Developer-facing fix guidance used in fix prompts. */
export const FIX_GUIDANCE = {
	text_overlap: 'Find why the two elements share space: absolute/negative positioning, fixed heights with growing text, or negative margins. Let the layout flow (flex/grid gap), remove fixed heights, and verify at every breakpoint.',
	control_obscured: 'Remove or reposition the covering element, or fix its stacking (z-index / pointer-events: none on decorative layers) so the control is on top and receives clicks.',
	text_obscured: 'Adjust stacking order or spacing so the covering element no longer sits on top of readable content.',
	text_clipped: 'Avoid fixed widths/heights with overflow: hidden on text containers. Let text wrap (min-width: 0; overflow-wrap: anywhere), or truncate intentionally with text-overflow: ellipsis and a title/tooltip.',
	text_overflow_box: 'Let the box grow with its content (remove fixed height/width, use padding and min-height) or allow wrapping inside it.',
	horizontal_overflow: 'Find the elements wider than the viewport (fixed pixel widths, long unbroken strings, wide tables/images). Use max-width: 100%, flexible units, overflow-wrap and responsive tables/scroll containers.',
	blocking_overlay: 'Make the overlay smaller, dismissible with a visible close control and Escape, and do not block the main content on small screens.',
	small_touch_targets: 'Give interactive elements at least 24×24px (preferably 44×44px) hit areas via padding or min-width/min-height.',
	broken_image: 'Fix the image URL or asset pipeline, and add a graceful fallback for failed images.',
	distorted_image: 'Preserve aspect ratio: set width or height to auto, or use object-fit: cover/contain with explicit dimensions.',
	image_alt_missing: 'Add meaningful alt text to informative images and alt="" to decorative ones.',
	control_no_name: 'Give icon-only buttons and links an accessible name with visible text, aria-label, or an <svg><title>.',
	field_no_label: 'Associate every form field with a <label for> (or aria-labelledby). Placeholders are not labels.',
	missing_lang: 'Add a lang attribute to the <html> element, e.g. <html lang="en">.',
	zoom_disabled: 'Remove user-scalable=no and maximum-scale=1 from the viewport meta tag.',
	viewport_meta_missing: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to every page.',
	duplicate_ids: 'Make every id unique; generate ids per component instance.',
	low_contrast: 'Darken the text or lighten the background so the contrast ratio meets 4.5:1 (3:1 for large text). Check hover/disabled states too.',
	broken_text: 'Guard rendering against missing data: format values, provide defaults and empty states, and never interpolate undefined/NaN/objects into the UI.',
	placeholder_copy: 'Replace placeholder copy with final content.',
	blank_page: 'Check for a failed client-side render (see console errors), a missing data dependency, or a server error, and render an error state instead of a blank page.',
	missing_title: 'Set a unique, descriptive <title> for each page.',
	missing_h1: 'Add one visible <h1> that describes the page.',
	broken_anchor: 'Point the link to an existing element id or remove it.',
	hidden_content: 'Make sure scroll-reveal animations always end visible: trigger them with IntersectionObserver thresholds that are reachable, add a no-JS/reduced-motion fallback, and never leave opacity: 0 as the end state.',
	console_error: 'Open the browser console on this page, fix the failing code path, and add error handling so the UI degrades gracefully.',
	page_error: 'Fix the uncaught exception (stack trace in evidence) and add an error boundary so one failure does not break the page.',
	failed_request: 'Fix the endpoint or asset path, and handle failures in the UI (retry or error state).',
	http_error_page: 'Fix the route or server error, and serve a helpful error page.',
	slow_load: 'Reduce render-blocking resources, compress and lazy-load images, cache static assets, and split large bundles.',
	layout_shift: 'Reserve space for late-loading content (width/height on images, min-height on banners, font-display strategies) so the layout does not jump.',
	heavy_page: 'Compress images (WebP/AVIF), lazy-load below-the-fold media and split JavaScript bundles.',
	long_tasks: 'Break up long JavaScript tasks (code splitting, web workers, deferring non-critical work) so the main thread stays responsive.',
	mixed_content: 'Load every resource over HTTPS.',
	invalid_nesting: 'Do not put links, buttons or fields inside other links or buttons. Make the outer element a non-interactive container (div/li with an onClick on a dedicated inner control), or move the inner control beside it.',
	form_in_form: 'Remove the nested <form>; use one form, or the form= attribute on controls that belong to another form.',
	orphan_list_item: 'Wrap <li> elements in <ul>, <ol> or <menu>, or use a different element when it is not a list.',
	broken_aria_reference: 'Point aria-labelledby/aria-describedby/aria-controls and label for= at ids that exist (generate ids per component instance and keep them in sync), or remove the reference.',
	aria_hidden_focusable: 'Make hidden content non-focusable: use the inert attribute on the hidden container, or tabindex="-1" on its controls, or stop hiding it with aria-hidden.',
	invalid_role: 'Use a valid WAI-ARIA role (or the native element that has it), or remove the role attribute.',
	excessive_dom: 'Reduce the DOM: virtualize long lists and tables, render hidden tabs and menus on demand, and remove wrapper elements that add no structure.'
};

async function highlight(page, rect, label) {
	if (!rect) return undefined;
	try {
		await page.evaluate(({ rect, label }) => {
			const box = document.createElement('div');
			box.id = '__qase_highlight';
			Object.assign(box.style, { position: 'absolute', left: `${rect.x - 3}px`, top: `${rect.y - 3}px`, width: `${rect.width + 6}px`, height: `${rect.height + 6}px`,
				border: '3px solid #ff2d55', borderRadius: '4px', background: 'rgba(255,45,85,0.12)', zIndex: '2147483647', pointerEvents: 'none', boxSizing: 'border-box' });
			const tag = document.createElement('div');
			tag.textContent = label;
			Object.assign(tag.style, { position: 'absolute', left: '0', top: '-22px', background: '#ff2d55', color: '#fff', font: '600 12px system-ui', padding: '2px 6px', borderRadius: '3px', whiteSpace: 'nowrap' });
			box.append(tag);
			document.body.append(box);
		}, { rect, label: label.slice(0, 60) });
		const viewport = page.viewportSize();
		const y = Math.max(0, rect.y - Math.round(viewport.height / 3));
		await page.evaluate(top => window.scrollTo(0, top), y);
		await page.waitForTimeout(120);
		// Surrounding fields are visible in a viewport capture even when a
		// different control is the subject of the finding.
		const fields = page.locator('input:not([type=button],[type=submit],[type=reset],[type=image],[type=checkbox],[type=radio],[type=hidden]), textarea, select, [contenteditable]:not([contenteditable=false])');
		return await page.screenshot({ type: 'jpeg', quality: 70, timeout: 5000, mask: [fields, page.locator('iframe,frame')] });
	} catch {
		return undefined;
	} finally {
		await page.evaluate(() => document.getElementById('__qase_highlight')?.remove()).catch(() => {});
	}
}

/** Elements with text that remain invisible after being scrolled into view. */
async function hiddenAfterScroll(page) {
	return page.evaluate(() => {
		const out = [];
		for (const element of document.querySelectorAll('section,article,div,p,h1,h2,h3,li,img,figure')) {
			if (out.length >= 3) break;
			const r = element.getBoundingClientRect();
			if (r.top < 0 || r.bottom > innerHeight || r.width < 40 || r.height < 16) continue;
			const s = getComputedStyle(element);
			if (s.display === 'none' || s.visibility === 'hidden') continue;
			const text = (element.innerText || element.alt || '').trim();
			if (!text && element.tagName !== 'IMG') continue;
			if (Number(s.opacity) > 0.05) continue;
			if (element.parentElement && Number(getComputedStyle(element.parentElement).opacity) <= 0.05) continue;
			if (element.closest('[aria-hidden="true"],[hidden],dialog:not([open])')) continue;
			out.push({ selector: element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}${element.className && typeof element.className === 'string' ? '.' + element.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`,
				text: text.slice(0, 80), rect: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) } });
		}
		return out;
	}).catch(() => []);
}

/**
 * Computed-style contrast cannot see pseudo-element backgrounds, gradients or
 * images, so every low-contrast claim is re-measured on real pixels: the
 * element is screenshotted and the darkest and lightest pixel bands give the
 * rendered contrast. Claims the pixels disprove are dropped.
 */
async function measureRenderedContrast(page, selector) {
	try {
		const locator = page.locator(selector).first();
		const bytes = await locator.screenshot({ type: 'png', timeout: 3000, animations: 'disabled' });
		return await page.evaluate(async base64 => {
			const image = new Image();
			image.src = `data:image/png;base64,${base64}`;
			await image.decode();
			const canvas = document.createElement('canvas');
			canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
			const context = canvas.getContext('2d', { willReadFrequently: true });
			context.drawImage(image, 0, 0);
			const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
			const channel = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
			const values = [];
			for (let i = 0; i < data.length; i += 4) values.push(0.2126 * channel(data[i]) + 0.7152 * channel(data[i + 1]) + 0.0722 * channel(data[i + 2]));
			if (values.length < 16) return undefined;
			values.sort((a, b) => a - b);
			const low = values[Math.floor(values.length * 0.03)], high = values[Math.floor(values.length * 0.97)];
			return Math.round(((high + 0.05) / (low + 0.05)) * 100) / 100;
		}, bytes.toString('base64'));
	} catch { return undefined; }
}

async function verifyContrast(issue, page) {
	const confirmed = [];
	for (const item of issue.measurements ?? []) {
		const rendered = await measureRenderedContrast(page, item.selector);
		// Text rarely fills its box, so rendered contrast can only under-state; a clearly
		// higher rendered value means the computed colours were wrong.
		if (rendered !== undefined && rendered >= item.required * 0.95) continue;
		confirmed.push({ ...item, rendered });
	}
	if (!confirmed.length) return undefined;
	const describe = item => `"${item.label}" ${(item.rendered ?? item.ratio).toFixed(2)}:1 (needs ${item.required}:1${item.rendered !== undefined ? ', measured on screen' : ''})`;
	return { ...issue, title: `${confirmed.length} text element${confirmed.length === 1 ? ' has' : 's have'} insufficient colour contrast`,
		actual: `Examples: ${confirmed.slice(0, 4).map(describe).join('; ')}.`, examples: confirmed.map(item => item.selector), selector: confirmed[0].selector,
		severity: confirmed.some(item => (item.rendered ?? item.ratio) < 3) ? 'medium' : 'low', confidence: confirmed.every(item => item.rendered !== undefined) ? 0.9 : 0.7 };
}

/**
 * Audits one loaded page. `save(bytes, label)` stores an artifact and returns its id.
 * Returns { candidates, metrics }.
 */
export async function auditPage(page, { url, viewport, touch = false, log, save, maxScreens = 6 }) {
	const candidates = [];
	const seen = new Set();
	let metrics;
	const height = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
	const step = page.viewportSize()?.height ?? 800;
	const screens = Math.max(1, Math.min(maxScreens, Math.ceil(height / step)));
	const hidden = [];
	for (let screen = 0; screen < screens; screen++) {
		await page.evaluate(top => window.scrollTo(0, top), screen * step).catch(() => {});
		await page.waitForTimeout(screen === 0 ? 150 : 650);
		let result;
		const size = page.viewportSize();
		try { result = await page.evaluate(pageAudit, { touch, mobileCheck: touch, viewportWidth: size?.width, viewportHeight: size?.height }); }
		catch { continue; }
		metrics ??= result.metrics;
		for (const issue of result.issues) {
			const key = `${issue.kind}|${issue.key ?? issue.selector}`;
			if (seen.has(key)) continue;
			seen.add(key);
			candidates.push({ issue, screen });
		}
		if (screen > 0) for (const item of await hiddenAfterScroll(page)) if (!hidden.some(existing => existing.selector === item.selector)) hidden.push(item);
	}
	// Re-check hidden content after a longer wait: slow reveal animations are fine.
	if (hidden.length) {
		await page.waitForTimeout(1500);
		const still = [];
		for (const item of hidden) {
			const opacity = await page.evaluate(({ y }) => {
				window.scrollTo(0, Math.max(0, y - 100));
				return true;
			}, item.rect).then(() => page.waitForTimeout(900)).then(() => page.evaluate(selector => {
				try { const element = document.querySelector(selector); return element ? Number(getComputedStyle(element).opacity) : 1; } catch { return 1; }
			}, item.selector)).catch(() => 1);
			if (opacity <= 0.05) still.push(item);
		}
		for (const item of still.slice(0, 3)) candidates.push({ issue: { kind: 'hidden_content', severity: 'high', confidence: 0.75,
			title: `Content stays invisible after scrolling into view: "${item.text.slice(0, 50)}"`,
			actual: `${item.selector} is in the viewport but remains at opacity 0 after 2.5 s, so users never see it. This is usually a scroll-reveal animation that never fires.`,
			expected: 'Content becomes visible once it is scrolled into view.', selector: item.selector, rect: item.rect, key: item.selector } });
	}

	for (const entry of candidates) {
		if (entry.issue.kind === 'low_contrast') entry.issue = await verifyContrast(entry.issue, page);
	}
	const out = [];
	let shots = 0;
	for (const { issue } of candidates.filter(entry => entry.issue)) {
		let artifactId;
		if (issue.rect && shots < 8 && ['high', 'medium'].includes(issue.severity)) {
			const bytes = await highlight(page, issue.rect, issue.title);
			if (bytes) { artifactId = await save(bytes, `${viewport}: ${issue.title}`); shots++; }
		}
		out.push(candidate({
			detector: `page.${issue.kind}`, category: CATEGORY[issue.kind] ?? 'layout', severity: issue.severity, confidence: issue.confidence,
			title: issue.title, url, viewport, selector: issue.selector, expected: issue.expected, actual: issue.actual,
			evidence: [issue.otherSelector ? `Covering/other element: ${issue.otherSelector}` : '', issue.examples?.length ? `Affected: ${issue.examples.join(', ')}` : '', issue.rect ? `Position on page: x=${issue.rect.x}, y=${issue.rect.y}, ${issue.rect.width}×${issue.rect.height}px` : ''].filter(Boolean).join('\n'),
			steps: [`Open ${url} at the ${viewport} viewport`, issue.rect ? `Scroll to y≈${issue.rect.y}px` : 'Look at the page', `Inspect ${issue.selector}`],
			fix: FIX_GUIDANCE[issue.kind], artifactId,
			data: { key: issue.key, siteWide: Boolean(issue.siteWide), ignoreSelector: Boolean(issue.ignoreSelector) }
		}));
	}

	// Console and resource failures are observations. The run's runtime monitor
	// produces candidates only for a breached expectation with supporting events.
	if (log?.mainResponse && !log.mainResponse.statusContract && log.mainResponse.status >= 400) out.push(candidate({ detector: 'page.http_error_page', category: 'functional', severity: log.mainResponse.status >= 500 ? 'critical' : 'high', confidence: 0.95,
		title: `Page returns HTTP ${log.mainResponse.status}`, url, viewport, actual: `${url} responded with HTTP ${log.mainResponse.status}.`, expected: 'The page loads successfully.',
		steps: [`Open ${url}`], fix: FIX_GUIDANCE.http_error_page, data: { key: String(log.mainResponse.status) } }));

	// ---------- Performance ----------
	if (metrics) {
		if (metrics.lcpMs > 4000 || metrics.loadMs > 8000) out.push(candidate({ detector: 'page.slow_load', category: 'performance', severity: metrics.lcpMs > 6000 || metrics.loadMs > 12000 ? 'medium' : 'low', confidence: 0.6,
			title: `Page is slow to show its main content (${Math.round((metrics.lcpMs || metrics.loadMs) / 100) / 10}s)`, url, viewport,
			actual: `Largest contentful paint ${metrics.lcpMs ?? 'n/a'} ms, load event ${metrics.loadMs ?? 'n/a'} ms.`, expected: 'Main content appears within 2.5 s (good) and no later than 4 s.',
			fix: FIX_GUIDANCE.slow_load, data: { key: 'slow_load' } }));
		if (metrics.cls > 0.1) out.push(candidate({ detector: 'page.layout_shift', category: 'animation', severity: metrics.cls > 0.25 ? 'medium' : 'low', confidence: 0.8,
			title: `Layout jumps while the page loads (CLS ${metrics.cls})`, url, viewport,
			actual: `Cumulative layout shift is ${metrics.cls}.${metrics.shiftSources.length ? ` Shifted elements: ${metrics.shiftSources.map(item => `${item.nodes.join(', ') || 'unknown'} (${item.value} at ${item.at} ms)`).join('; ')}.` : ''}`,
			expected: 'Content stays put while loading (CLS below 0.1).', fix: FIX_GUIDANCE.layout_shift, data: { key: 'cls' } }));
		if (metrics.transferBytes > 5_000_000) out.push(candidate({ detector: 'page.heavy_page', category: 'performance', severity: 'low', confidence: 0.7,
			title: `Page downloads ${Math.round(metrics.transferBytes / 100000) / 10} MB`, url, viewport,
			actual: `Total transfer ${metrics.transferBytes} bytes.${metrics.largeResources.length ? ` Largest: ${metrics.largeResources.map(item => `${item.url.split('/').pop().slice(0, 50)} (${Math.round(item.bytes / 1000)} KB)`).join(', ')}.` : ''}`,
			expected: 'Pages stay well under 3 MB, especially on mobile.', fix: FIX_GUIDANCE.heavy_page, data: { key: 'heavy' } }));
		if (metrics.longestTaskMs > 300) out.push(candidate({ detector: 'page.long_tasks', category: 'performance', severity: metrics.longestTaskMs > 800 ? 'medium' : 'low', confidence: 0.6,
			title: `Main thread blocked for ${metrics.longestTaskMs} ms`, url, viewport, actual: `${metrics.longTasks} long tasks; the longest took ${metrics.longestTaskMs} ms, during which the page cannot respond to input.`,
			expected: 'No single task blocks the main thread for more than 200 ms.', fix: FIX_GUIDANCE.long_tasks, data: { key: 'long_tasks' } }));
		if (metrics.mixedContent.length) out.push(candidate({ detector: 'security.mixed_content', category: 'security', severity: 'medium', confidence: 0.9,
			title: 'HTTPS page loads insecure HTTP resources', url, viewport, actual: `Insecure resources: ${metrics.mixedContent.join(', ')}.`,
			expected: 'Every resource on an HTTPS page is loaded over HTTPS.', fix: FIX_GUIDANCE.mixed_content, data: { key: 'mixed', siteWide: true } }));
	}
	return { candidates: out, metrics };
}
