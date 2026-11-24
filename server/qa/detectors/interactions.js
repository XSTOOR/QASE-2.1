/**
 * Interaction and animation detectors.
 *
 * For each toggle-like control (menus, dropdowns, accordions, tabs, dialogs,
 * hamburger buttons) the detector clicks it inside the read-only interaction
 * window and measures what really happens:
 *   - does anything change at all (dead controls)?
 *   - where does the opened UI end up: off-screen, behind other content,
 *     clipped by a container, never finishing its animation?
 *   - how does it animate: duration, animated layout properties, dropped frames?
 *   - can it be closed again with Escape / a second click; does focus move?
 * Desktop navigation submenus are also hovered to catch menus that close
 * before the pointer reaches them. A reduced-motion pass checks that motion
 * is reduced when the user asks for it.
 */
import { candidate } from '../findings.js';
import { domHealth, DOM_FIX } from './dom.js';

// Sign-in-with buttons hand off to another site; QASE blocks that navigation, so
// their spinner/loading state is a harness artifact, not an animation to grade.
const HANDOFF = /\b(continue|sign ?in|log ?in|sign ?up|register) with\b|\b(google|github|gitlab|apple|microsoft|facebook|linkedin|twitter|okta|sso|saml|oauth)\b/i;
const SPINNER = /spin|spinner|loader|loading|progress|skeleton|shimmer|pulse/i;

const DESTRUCTIVE = /\b(delete|remove|destroy|erase|log ?out|sign ?out|unsubscribe|deactivate|cancel (?:my )?(?:subscription|account|order)|pay|purchase|buy|checkout|place order|confirm|submit|send|transfer|book now|reset)\b/i;

export const MOTION_FIX = {
	dead_control: 'Wire the control to its handler (check for a JavaScript error, a missing event listener, or a click swallowed by an overlay), or render it as non-interactive if it has no action.',
	expanded_without_content: 'Make the control reveal the element referenced by aria-controls, and keep aria-expanded in sync with the real state.',
	aria_expanded_stale: 'Update aria-expanded (true/false) on the toggle whenever the controlled panel opens or closes.',
	opens_offscreen: 'Constrain the panel to the viewport: position it relative to the trigger with collision detection (flip/shift), use max-width: 100vw and check right-aligned menus on small screens.',
	opens_behind: 'Give the opened panel a stacking context above the page content (z-index on the positioned ancestor, avoid transform/overflow on parents that trap it) or render it in a portal at the end of <body>.',
	clipped_by_container: 'An ancestor with overflow: hidden cuts the panel off. Render the panel outside that container (portal), or remove overflow clipping from the ancestor.',
	animation_unfinished: 'Ensure the transition/animation ends in the final visible state (opacity: 1, transform: none). Check that transitionend handlers run and that classes are applied after the element is displayed.',
	slow_animation: 'Keep UI feedback animations short (150–300 ms for menus, under 500 ms for larger panels). Long animations make the interface feel unresponsive.',
	layout_animation: 'Animate transform and opacity instead of width/height/top/left/margin, which force layout on every frame and stutter on slower devices.',
	janky_animation: 'Reduce main-thread work during the animation (avoid layout-property animation, heavy scripts or large repaints); prefer transform/opacity with will-change on the animated element.',
	escape_does_not_close: 'Close menus and dialogs on Escape and return focus to the trigger (WAI-ARIA Authoring Practices).',
	focus_not_moved: 'Move focus into a dialog when it opens (first focusable element or the dialog itself) and trap focus until it closes.',
	scrollbar_shift: 'When locking body scroll for an overlay, compensate for the removed scrollbar (scrollbar-gutter: stable or padding-right equal to the scrollbar width).',
	submenu_hover_gap: 'Remove the gap between the menu item and its submenu, add a short close delay, or use a hover "safe triangle" so the submenu stays open while the pointer travels to it.',
	reduced_motion_ignored: 'Respect prefers-reduced-motion: wrap non-essential motion in @media (prefers-reduced-motion: no-preference) or shorten/disable it under reduce.',
	infinite_animation: 'Stop decorative infinite animations after a few cycles, or provide a pause control (WCAG 2.2.2) and honour reduced motion.'
};

/** Marks and returns toggle-like controls in priority order. */
async function findTriggers(page, limit) {
	return page.evaluate(({ limit, destructive, handoff }) => {
		const destructiveRe = new RegExp(destructive, 'i');
		const handoffRe = new RegExp(handoff, 'i');
		const visible = element => {
			const r = element.getBoundingClientRect();
			const s = getComputedStyle(element);
			return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05 && r.bottom > 0 && r.top < document.documentElement.scrollHeight;
		};
		const name = element => String(element.getAttribute('aria-label') || element.innerText || element.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
		const pool = new Map();
		const score = (element, value) => { if (!pool.has(element) || pool.get(element) < value) pool.set(element, value); };
		for (const element of document.querySelectorAll('[aria-expanded],[aria-haspopup]:not([aria-haspopup=false])')) score(element, 10);
		for (const element of document.querySelectorAll('summary,[role=tab],[data-toggle],[data-bs-toggle],[data-toggle-target],[aria-controls]')) score(element, 8);
		for (const element of document.querySelectorAll('button,[role=button]')) {
			const text = name(element) + ' ' + (element.className?.toString?.() ?? '') + ' ' + (element.id ?? '');
			if (/menu|nav|hamburger|burger|toggle|more|options|filter|sort|expand|collapse|show|open|close|dropdown|accordion|faq|tab|☰|⋮|…/i.test(text)) score(element, 6);
			else if (!element.closest('form')) score(element, 3);
		}
		const out = [];
		for (const [element, value] of [...pool].sort((a, b) => b[1] - a[1])) {
			if (out.length >= limit) break;
			if (!visible(element)) continue;
			if (element.closest('form') && (element.type === 'submit' || element.matches('form button:not([type])'))) continue;
			if (element.tagName === 'A' && element.getAttribute('href') && !element.getAttribute('href').startsWith('#') && !element.hasAttribute('aria-expanded') && !element.hasAttribute('aria-haspopup')) continue;
			if (destructiveRe.test(name(element))) continue;
			if (handoffRe.test(name(element)) || element.closest('a[target=_blank]')) continue;
			if (element.disabled || element.getAttribute('aria-disabled') === 'true') continue;
			const id = `t${out.length}`;
			element.setAttribute('data-qase-trigger', id);
			out.push({ id, label: name(element) || element.tagName.toLowerCase(), tag: element.tagName.toLowerCase(), expanded: element.getAttribute('aria-expanded'), controls: element.getAttribute('aria-controls'), priority: value,
				selector: element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}${element.className && typeof element.className === 'string' && element.className.trim() ? '.' + element.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}` });
		}
		return out;
	}, { limit, destructive: DESTRUCTIVE.source, handoff: HANDOFF.source }).catch(() => []);
}

/** Records the pre-interaction state inside the page. */
async function arm(page, id) {
	return page.evaluate(id => {
		const trigger = document.querySelector(`[data-qase-trigger="${id}"]`);
		const visibleNow = new WeakSet();
		const positions = [];
		for (const element of document.body.querySelectorAll('*')) {
			const r = element.getBoundingClientRect();
			if (r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== 'hidden') {
				visibleNow.add(element);
				if (positions.length < 250 && r.top >= 0 && r.top < innerHeight && element.children.length === 0 && !trigger?.contains(element)) positions.push({ element, top: r.top, left: r.left });
			}
		}
		const record = { visibleNow, positions, mutations: 0, events: [], frames: [], url: location.href, scrollWidth: document.documentElement.clientWidth, start: performance.now() };
		record.observer = new MutationObserver(list => { record.mutations += list.length; });
		record.observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
		const describe = node => node?.nodeType === 1 ? `${node.tagName.toLowerCase()}${node.id ? '#' + node.id : ''}${node.classList?.length ? '.' + [...node.classList].slice(0, 2).join('.') : ''}` : '';
		record.listener = event => {
			if (record.events.length > 200) return;
			const s = event.target?.nodeType === 1 ? getComputedStyle(event.target) : null;
			record.events.push({ type: event.type, property: event.propertyName, name: event.animationName, target: describe(event.target), t: Math.round(performance.now() - record.start),
				duration: s ? (event.type.startsWith('transition') ? s.transitionDuration : s.animationDuration) : undefined, iterations: s?.animationIterationCount });
		};
		for (const type of ['transitionrun', 'transitionend', 'animationstart', 'animationend']) document.addEventListener(type, record.listener, true);
		let last = performance.now();
		const tick = now => { if (record.frames.length < 400) record.frames.push(now - last); last = now; if (!record.stopped) requestAnimationFrame(tick); };
		requestAnimationFrame(tick);
		window.__qaseInteraction = record;
		return Boolean(trigger);
	}, id).catch(() => false);
}

/** Evaluates the post-interaction state. */
async function inspect(page, id) {
	return page.evaluate(id => {
		const record = window.__qaseInteraction;
		if (!record) return null;
		record.stopped = true;
		record.observer.disconnect();
		for (const type of ['transitionrun', 'transitionend', 'animationstart', 'animationend']) document.removeEventListener(type, record.listener, true);
		const trigger = document.querySelector(`[data-qase-trigger="${id}"]`);
		const vw = innerWidth, vh = innerHeight;
		const describe = node => node?.nodeType === 1 ? (node.id ? `#${node.id}` : `${node.tagName.toLowerCase()}${node.classList?.length ? '.' + [...node.classList].slice(0, 2).join('.') : ''}`) : '';
		const shown = [];
		for (const element of document.body.querySelectorAll('*')) {
			if (record.visibleNow.has(element)) continue;
			const r = element.getBoundingClientRect();
			const s = getComputedStyle(element);
			if (r.width < 8 || r.height < 8 || s.visibility === 'hidden' || s.display === 'none') continue;
			if (shown.some(item => item.contains(element))) continue;
			for (let i = shown.length - 1; i >= 0; i--) if (element.contains(shown[i])) shown.splice(i, 1);
			shown.push(element);
		}
		const regions = shown.filter(element => (element.innerText || '').trim() || element.querySelector('a,button,input,img'));
		let region = null;
		if (regions.length) {
			const rects = regions.map(element => element.getBoundingClientRect());
			region = { left: Math.min(...rects.map(r => r.left)), top: Math.min(...rects.map(r => r.top)), right: Math.max(...rects.map(r => r.right)), bottom: Math.max(...rects.map(r => r.bottom)) };
			region.width = region.right - region.left; region.height = region.bottom - region.top;
		}
		const main = regions.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
		const result = {
			url: location.href, navigated: location.href !== record.url, mutations: record.mutations,
			expandedAfter: trigger?.getAttribute('aria-expanded'), triggerPresent: Boolean(trigger),
			region: region ? { x: Math.round(region.left + scrollX), y: Math.round(region.top + scrollY), width: Math.round(region.width), height: Math.round(region.height), left: region.left, right: region.right, top: region.top, bottom: region.bottom } : null,
			regionSelector: describe(main), regionText: (main?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
			events: record.events, frames: record.frames.slice(2)
		};
		if (main) {
			const s = getComputedStyle(main);
			result.position = s.position;
			result.opacity = Number(s.opacity);
			result.transform = s.transform;
			result.role = main.getAttribute('role') || (main.tagName === 'DIALOG' ? 'dialog' : '');
			result.modal = main.getAttribute('aria-modal') === 'true' || main.tagName === 'DIALOG';
			result.focusInside = main.contains(document.activeElement);
			// Ancestors with opacity still animating also count.
			let effective = Number(s.opacity);
			for (let node = main.parentElement; node && node !== document.body; node = node.parentElement) effective *= Number(getComputedStyle(node).opacity);
			result.effectiveOpacity = effective;
			// Occlusion: sample points inside the visible part of the region.
			const r = main.getBoundingClientRect();
			const points = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]
				.map(([fx, fy]) => [r.left + r.width * fx, r.top + r.height * fy])
				.filter(([x, y]) => x >= 0 && y >= 0 && x < vw && y < vh);
			let covered = 0, coverer = '';
			for (const [x, y] of points) {
				const top = document.elementFromPoint(x, y);
				if (top && !main.contains(top) && !top.contains(main) && !trigger?.contains(top)) { covered++; coverer = describe(top); }
			}
			result.sampled = points.length; result.covered = covered; result.coverer = coverer;
			// Clipping by an overflow-hidden ancestor.
			for (let node = main.parentElement; node && node !== document.body; node = node.parentElement) {
				const ps = getComputedStyle(node);
				if (!['hidden', 'clip'].includes(ps.overflowX) && !['hidden', 'clip'].includes(ps.overflowY)) continue;
				const pr = node.getBoundingClientRect();
				if (r.right > pr.right + 4 || r.bottom > pr.bottom + 4 || r.left < pr.left - 4 || r.top < pr.top - 4) { result.clippedBy = describe(node); break; }
			}
		}
		// Horizontal shift of unrelated content (scrollbar removal when locking scroll).
		let horizontal = 0;
		for (const item of record.positions) {
			if (!item.element.isConnected || main?.contains(item.element)) continue;
			const r = item.element.getBoundingClientRect();
			if (Math.abs(r.top - item.top) < 2) horizontal = Math.max(horizontal, Math.abs(r.left - item.left));
		}
		result.horizontalShift = Math.round(horizontal);
		result.clientWidthChange = document.documentElement.clientWidth - record.scrollWidth;
		delete window.__qaseInteraction;
		return result;
	}, id).catch(() => null);
}

const seconds = value => {
	const parts = String(value ?? '').split(',').map(part => part.trim());
	return Math.max(0, ...parts.map(part => part.endsWith('ms') ? parseFloat(part) / 1000 : parseFloat(part) || 0));
};
const LAYOUT_PROPERTIES = /^(width|height|top|left|right|bottom|margin|padding|max-height|max-width|min-height)/;

async function regionVisible(page, selector) {
	if (!selector) return false;
	return page.evaluate(selector => {
		try {
			const element = document.querySelector(selector);
			if (!element) return false;
			const r = element.getBoundingClientRect();
			const s = getComputedStyle(element);
			return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.1;
		} catch { return false; }
	}, selector).catch(() => false);
}

/**
 * Tests the toggles on one page. `reload()` restores the base state.
 * Returns { candidates, tested, frames: [{label, bytes}] }.
 */
export async function testInteractions(page, { url, viewport, browser, reload, save, limit = 8, deadline = Infinity }) {
	const out = [];
	const filmstrips = [];
	let tested = 0;
	let leakChecks = 0;
	let triggers = await findTriggers(page, limit);
	for (let index = 0; index < triggers.length && Date.now() < deadline; index++) {
		const trigger = triggers[index];
		const healthBefore = await domHealth(page);
		const armed = await arm(page, trigger.id);
		if (!armed) continue;
		const frames = [];
		let clicked = true;
		const blockedBefore = browser.blocked?.() ?? {};
		await browser.interact(async () => {
			try {
				await browser.pointAt?.(page, page.locator(`[data-qase-trigger="${trigger.id}"]`).first(), `Click "${String(trigger.label ?? '').slice(0, 30)}"`);
				await browser.hideCursor?.(page); // filmstrip frames must show the app, not the cursor
				await page.locator(`[data-qase-trigger="${trigger.id}"]`).first().click({ timeout: 8000 });
			} catch { clicked = false; }
			// Filmstrip at roughly 90 ms, 220 ms and 450 ms after the click.
			for (const wait of [90, 130, 230]) {
				await page.waitForTimeout(wait);
				try { frames.push(await page.screenshot({ type: 'jpeg', quality: 50, timeout: 1500, animations: 'allow' })); } catch { /* ignore */ }
			}
			await page.waitForTimeout(1050);
		});
		const result = await inspect(page, trigger.id);
		if (!clicked || !result) { await reload(); triggers = await findTriggers(page, limit); continue; }
		tested++;
		// A control that tried to leave the site or submit data is a link or a submit button:
		// what follows (spinners, "Failed to fetch") is caused by QASE's block, so it is not graded.
		const blockedAfter = browser.blocked?.() ?? {};
		if ((blockedAfter.offsite_navigation ?? 0) > (blockedBefore.offsite_navigation ?? 0) || (blockedAfter.write_blocked ?? 0) > (blockedBefore.write_blocked ?? 0)) {
			await reload();
			triggers = await findTriggers(page, limit);
			continue;
		}
		const base = { url, viewport, selector: trigger.selector, steps: [`Open ${url} at the ${viewport} viewport`, `Click "${trigger.label}" (${trigger.selector})`] };
		const changed = result.navigated || result.mutations > 0 || result.region;
		const add = (kind, fields) => out.push(candidate({ detector: `motion.${kind}`, category: fields.category ?? 'animation', fix: MOTION_FIX[kind], ...base, ...fields, data: { key: `${kind}:${trigger.selector}:${trigger.label}`, ...(fields.data ?? {}) } }));
		let artifactId;
		const evidenceShot = async label => {
			if (artifactId || !frames.length) return artifactId;
			artifactId = await save(frames.at(-1), `${viewport}: ${label}`);
			return artifactId;
		};

		if (result.navigated) {
			await reload();
			triggers = await findTriggers(page, limit);
			continue;
		}
		if (!changed) {
			add('dead_control', { category: 'functional', severity: trigger.expanded !== null || trigger.priority >= 8 ? 'medium' : 'low', confidence: trigger.expanded !== null ? 0.8 : 0.55,
				title: `"${trigger.label}" does nothing when clicked`,
				actual: `Clicking ${trigger.selector} produced no visible change, no DOM update, no navigation and no request${trigger.expanded !== null ? `; aria-expanded stayed "${trigger.expanded}"` : ''}.`,
				expected: 'Clicking a control performs its action or visibly responds.', artifactId: await evidenceShot('no response') });
			continue;
		}
		if (trigger.expanded !== null && result.expandedAfter === trigger.expanded && result.region) {
			add('aria_expanded_stale', { category: 'accessibility', severity: 'low', confidence: 0.8, title: `"${trigger.label}" does not update aria-expanded`,
				actual: `A panel ("${result.regionText}") opened, but aria-expanded stayed "${trigger.expanded}", so screen readers report the wrong state.`,
				expected: 'aria-expanded reflects whether the controlled panel is open.' });
		}
		if (trigger.expanded === 'false' && result.expandedAfter === 'true' && !result.region) {
			add('expanded_without_content', { category: 'functional', severity: 'medium', confidence: 0.75, title: `"${trigger.label}" claims to open but shows nothing`,
				actual: 'aria-expanded changed to "true", but no new content became visible.', expected: 'The menu or panel controlled by the toggle becomes visible.', artifactId: await evidenceShot('nothing shown') });
		}
		if (result.region) {
			const vw = page.viewportSize().width;
			const vh = page.viewportSize().height;
			if (result.region.right > vw + 2 || result.region.left < -2) {
				add('opens_offscreen', { category: 'layout', severity: 'medium', confidence: 0.85, title: `"${trigger.label}" opens a panel that is cut off by the screen edge`,
					actual: `The opened panel ${result.regionSelector} spans x=${Math.round(result.region.left)}…${Math.round(result.region.right)}px in a ${vw}px-wide viewport, so part of it is off-screen.`,
					expected: 'Opened menus and panels fit inside the viewport.', artifactId: await evidenceShot('off-screen panel') });
			}
			if (['fixed'].includes(result.position) && result.region.bottom > vh + 2 && result.region.height > vh * 0.5) {
				add('opens_offscreen', { category: 'layout', severity: 'medium', confidence: 0.6, title: `"${trigger.label}" opens a fixed panel taller than the screen`,
					actual: `The fixed panel ${result.regionSelector} is ${Math.round(result.region.height)}px tall in a ${vh}px viewport; its lower part cannot be scrolled into view.`,
					expected: 'Fixed panels fit the viewport or scroll internally (max-height: 100vh; overflow: auto).', artifactId: await evidenceShot('panel taller than screen') });
			}
			if (result.sampled >= 2 && result.covered >= Math.ceil(result.sampled * 0.6)) {
				add('opens_behind', { category: 'layout', severity: 'high', confidence: 0.85, title: `"${trigger.label}" opens behind other page content`,
					actual: `The opened panel ${result.regionSelector} is covered by ${result.coverer} at ${result.covered} of ${result.sampled} sampled points, so its items cannot be seen or clicked.`,
					expected: 'Opened menus and dropdowns appear above the page content.', artifactId: await evidenceShot('panel behind content') });
			}
			if (result.clippedBy) {
				add('clipped_by_container', { category: 'layout', severity: 'medium', confidence: 0.75, title: `"${trigger.label}" panel is clipped by its container`,
					actual: `The opened panel ${result.regionSelector} extends beyond ${result.clippedBy}, which has overflow hidden, so part of the panel is cut off.`,
					expected: 'Dropdowns and popovers are fully visible.', artifactId: await evidenceShot('clipped panel') });
			}
			if (result.effectiveOpacity > 0.05 && result.effectiveOpacity < 0.9) {
				add('animation_unfinished', { severity: 'medium', confidence: 0.7, title: `"${trigger.label}" animation never finishes (panel stays semi-transparent)`,
					actual: `1.5 s after the click the panel ${result.regionSelector} is still at ${Math.round(result.effectiveOpacity * 100)}% opacity.`,
					expected: 'Open animations end with the panel fully visible.', artifactId: await evidenceShot('unfinished animation') });
			}
			if (result.position === 'fixed' && (result.horizontalShift >= 8 || result.clientWidthChange >= 8)) {
				add('scrollbar_shift', { category: 'layout', severity: 'low', confidence: 0.65, title: `Page content jumps sideways when "${trigger.label}" opens`,
					actual: `Opening the overlay shifted page content ${Math.max(result.horizontalShift, result.clientWidthChange)}px horizontally (usually the scrollbar disappearing).`,
					expected: 'The page behind an overlay does not move.' });
			}
			if (result.modal && !result.focusInside) {
				add('focus_not_moved', { category: 'accessibility', severity: 'medium', confidence: 0.7, title: `Focus stays behind the "${trigger.label}" dialog`,
					actual: 'A modal dialog opened but keyboard focus remained on the page behind it.', expected: 'Focus moves into the dialog when it opens.' });
			}
		}
		// Animation quality.
		// Loading spinners and other infinite animations are not open/close transitions.
		const starts = result.events.filter(event => (event.type === 'transitionrun' || event.type === 'animationstart')
			&& event.iterations !== 'infinite' && !SPINNER.test(`${event.target} ${event.name ?? ''}`));
		const longest = Math.max(0, ...starts.map(event => seconds(event.duration)));
		if (longest >= 1) {
			add('slow_animation', { severity: longest >= 1.5 ? 'medium' : 'low', confidence: 0.75, title: `"${trigger.label}" animation takes ${longest.toFixed(1)} s`,
				actual: `The ${starts.find(event => seconds(event.duration) === longest)?.property ?? 'animation'} transition on ${starts.find(event => seconds(event.duration) === longest)?.target} lasts ${longest.toFixed(2)} s.`,
				expected: 'Menus and panels respond within about 300 ms.' });
		}
		const layoutAnimated = [...new Set(starts.filter(event => event.property && LAYOUT_PROPERTIES.test(event.property) && seconds(event.duration) >= 0.15).map(event => `${event.target} (${event.property})`))];
		const gaps = result.frames.filter(gap => gap > 50);
		const worstGap = Math.max(0, ...result.frames);
		if (starts.length && (gaps.length >= 4 || worstGap > 150)) {
			add('janky_animation', { severity: 'medium', confidence: layoutAnimated.length ? 0.7 : 0.5, title: `"${trigger.label}" animation stutters`,
				actual: `During the animation ${gaps.length} frames took longer than 50 ms (worst ${Math.round(worstGap)} ms) instead of ~16 ms.${layoutAnimated.length ? ` Layout properties are animated: ${layoutAnimated.slice(0, 3).join(', ')}.` : ''}`,
				expected: 'Animations run at a steady 60 fps.' });
		} else if (layoutAnimated.length) {
			add('layout_animation', { category: 'performance', severity: 'low', confidence: 0.7, title: `"${trigger.label}" animates layout properties`,
				actual: `Animated layout properties: ${layoutAnimated.slice(0, 4).join(', ')}. These force layout every frame and stutter on slower devices.`,
				expected: 'Animations use transform and opacity.' });
		}
		if (frames.length) filmstrips.push({ label: `${viewport} · ${trigger.label}`, url, frames });

		// Close behaviour.
		// Escape is expected to close overlays (dialogs, menus, popovers), not in-flow accordions.
		const overlay = ['absolute', 'fixed'].includes(result.position);
		if (result.region && (result.modal || result.role === 'menu' || result.role === 'listbox' || overlay && trigger.expanded !== null)) {
			await page.keyboard.press('Escape').catch(() => {});
			await page.waitForTimeout(600);
			if (await regionVisible(page, result.regionSelector)) {
				add('escape_does_not_close', { category: 'accessibility', severity: result.modal ? 'medium' : 'low', confidence: 0.7, title: `Escape does not close "${trigger.label}"`,
					actual: `After pressing Escape the ${result.modal ? 'dialog' : 'menu'} ${result.regionSelector} is still open.`, expected: 'Escape closes menus and dialogs.' });
			}
		}
		// DOM integrity while open: opening must not create duplicate ids or references to nothing.
		const healthOpen = result.region ? await domHealth(page) : undefined;
		if (healthBefore && healthOpen) {
			const newDuplicates = healthOpen.duplicateIds.filter(id => !healthBefore.duplicateIds.includes(id));
			const newBroken = healthOpen.brokenRefs.filter(ref => !healthBefore.brokenRefs.includes(ref));
			if (newDuplicates.length || newBroken.length) add('dom_invalid_after_open', { category: 'dom', severity: newBroken.length ? 'medium' : 'low', confidence: 0.8,
				title: `Opening "${trigger.label}" leaves the DOM invalid`,
				actual: `After the panel opened: ${[newDuplicates.length ? `duplicate ids ${newDuplicates.slice(0, 5).join(', ')}` : '', newBroken.length ? `references to missing elements ${newBroken.slice(0, 5).join(', ')}` : ''].filter(Boolean).join('; ')}.`,
				expected: 'Opened content has unique ids and its ARIA references resolve.', fix: DOM_FIX.dom_invalid_after_open });
		}
		// Restore the base state only when the control left something changed.
		const stillOpen = result.region && await regionVisible(page, result.regionSelector);
		// DOM leak: open and close the same control a few more times; a correct
		// component returns to the same element count every time it closes.
		if (result.region && !stillOpen && leakChecks < 2 && Date.now() < deadline - 8000) {
			leakChecks++;
			const locator = page.locator(`[data-qase-trigger="${trigger.id}"]`).first();
			const counts = [(await domHealth(page))?.nodes];
			for (let cycle = 0; cycle < 3; cycle++) {
				const opened = await browser.interact(async () => { await locator.click({ timeout: 3000 }); await page.waitForTimeout(450); }).then(() => true, () => false);
				if (!opened) break;
				await page.keyboard.press('Escape').catch(() => {});
				await page.waitForTimeout(450);
				if (await regionVisible(page, result.regionSelector)) await browser.interact(() => locator.click({ timeout: 3000 })).catch(() => {});
				await page.waitForTimeout(300);
				counts.push((await domHealth(page))?.nodes);
			}
			const valid = counts.every(Number.isFinite) && counts.length === 4;
			const steps = valid ? counts.slice(1).map((count, index) => count - counts[index]) : [];
			if (valid && steps.every(step => step >= 10) && counts[3] - counts[0] >= 45) {
				add('dom_leak', { category: 'dom', severity: counts[3] - counts[0] >= 300 ? 'medium' : 'low', confidence: 0.75,
					title: `"${trigger.label}" adds elements every time it is opened and closed (DOM leak)`,
					actual: `Element count after each close: ${counts.join(' → ')} (+${steps.join(', +')}). Closing does not remove what opening created, so the page grows and slows the longer it is used.`,
					expected: 'Opening and closing a control returns the page to the same number of elements.', fix: DOM_FIX.dom_leak,
					steps: [...base.steps, 'Close it (Escape)', 'Repeat open and close 3 times', 'Compare document.getElementsByTagName("*").length after each close'] });
			}
			// The repeated opening changed the page: start the next control from a clean load.
			await reload();
			triggers = await findTriggers(page, limit);
			continue;
		}
		if (stillOpen || result.mutations > 20 || result.position === 'fixed') {
			await reload();
			triggers = await findTriggers(page, limit);
		} else {
			await page.keyboard.press('Escape').catch(() => {});
			triggers = await findTriggers(page, limit);
		}
	}
	return { candidates: out, tested, filmstrips };
}

/** Desktop-only: hover navigation items that own a submenu. */
export async function testHoverMenus(page, { url, viewport, save, limit = 4 }) {
	const out = [];
	const items = await page.evaluate(limit => {
		const result = [];
		for (const item of document.querySelectorAll('nav li, header li, [role=menubar] > *')) {
			if (result.length >= limit) break;
			const submenu = item.querySelector(':scope > ul, :scope > div, :scope > [role=menu]');
			const link = item.querySelector(':scope > a, :scope > button, :scope > span');
			if (!submenu || !link) continue;
			const s = getComputedStyle(submenu);
			const hidden = s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.1 || submenu.getBoundingClientRect().height < 2;
			if (!hidden) continue;
			const id = `h${result.length}`;
			link.setAttribute('data-qase-hover', id);
			submenu.setAttribute('data-qase-submenu', id);
			result.push({ id, label: (link.innerText || '').trim().slice(0, 50) });
		}
		return result;
	}, limit).catch(() => []);
	for (const item of items) {
		try {
			const link = page.locator(`[data-qase-hover="${item.id}"]`).first();
			const box = await link.boundingBox();
			if (!box) continue;
			await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
			await page.waitForTimeout(450);
			const submenu = page.locator(`[data-qase-submenu="${item.id}"]`).first();
			const subBox = await submenu.boundingBox().catch(() => null);
			const shown = subBox && subBox.height > 4 && await regionVisible(page, `[data-qase-submenu="${item.id}"]`);
			if (!shown) continue; // click-to-open menus are covered by the toggle tests
			// Travel to the first submenu entry in small steps, as a person would.
			const target = { x: subBox.x + Math.min(40, subBox.width / 2), y: subBox.y + Math.min(14, subBox.height / 2) };
			await page.mouse.move(target.x, target.y, { steps: 12 });
			await page.waitForTimeout(250);
			if (!await regionVisible(page, `[data-qase-submenu="${item.id}"]`)) {
				const bytes = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => undefined);
				out.push(candidate({ detector: 'motion.submenu_hover_gap', category: 'navigation', severity: 'medium', confidence: 0.75, url, viewport,
					title: `"${item.label}" submenu closes before the pointer can reach it`,
					actual: `Hovering "${item.label}" opens its submenu, but moving the pointer down to the first submenu entry closes it, so its links cannot be clicked.`,
					expected: 'The submenu stays open while the pointer moves into it.',
					steps: [`Open ${url} on desktop`, `Hover "${item.label}"`, 'Move the pointer down into the submenu'],
					fix: MOTION_FIX.submenu_hover_gap, artifactId: bytes ? await save(bytes, `${viewport}: submenu closes`) : undefined, data: { key: `hover:${item.label}` } }));
			}
		} catch { /* one menu failing does not stop the others */ }
		await page.mouse.move(2, 2).catch(() => {});
		await page.waitForTimeout(200);
	}
	return out;
}

/** Runs in a reducedMotion:'reduce' context: motion should be minimal. */
export async function testReducedMotion(page, { url, viewport }) {
	const result = await page.evaluate(() => {
		const moving = [];
		for (const animation of document.getAnimations()) {
			const effect = animation.effect;
			const timing = effect?.getComputedTiming?.() ?? {};
			const target = effect?.target;
			if (!target || timing.duration < 300) continue;
			const keyframes = effect.getKeyframes?.() ?? [];
			const properties = new Set(keyframes.flatMap(frame => Object.keys(frame)).filter(key => !['offset', 'easing', 'composite', 'computedOffset'].includes(key)));
			const motion = [...properties].some(property => /transform|translate|rotate|scale|left|top|right|bottom|margin/.test(property));
			if (!motion) continue;
			const r = target.getBoundingClientRect();
			if (r.width < 24 || r.height < 24) continue;
			moving.push({ target: target.id ? `#${target.id}` : `${target.tagName.toLowerCase()}${target.classList.length ? '.' + [...target.classList].slice(0, 2).join('.') : ''}`,
				duration: Math.round(timing.duration), infinite: timing.iterations === Infinity, properties: [...properties].slice(0, 4) });
		}
		return moving.slice(0, 6);
	}).catch(() => []);
	if (!result.length) return [];
	return [candidate({ detector: 'motion.reduced_motion_ignored', category: 'accessibility', severity: result.some(item => item.infinite) ? 'medium' : 'low', confidence: 0.75, url, viewport,
		title: 'Animations keep running when the user asks for reduced motion',
		actual: `With prefers-reduced-motion: reduce, these elements still animate: ${result.map(item => `${item.target} (${item.properties.join('/')}, ${item.duration} ms${item.infinite ? ', infinite' : ''})`).join('; ')}.`,
		expected: 'Non-essential motion is removed or reduced under prefers-reduced-motion (WCAG 2.3.3).',
		steps: ['Enable "Reduce motion" in the operating system', `Open ${url}`], fix: MOTION_FIX.reduced_motion_ignored, data: { key: 'reduced_motion', siteWide: true } })];
}
