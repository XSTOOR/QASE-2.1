/**
 * DOM and idle-animation detectors that need time, not a single snapshot:
 *
 *   testIdle   — with nobody touching the page for a few seconds, the DOM
 *                should stay still and nothing should keep animating where no
 *                one can see it: DOM churn, infinite animations on hidden or
 *                off-screen elements, and a JavaScript animation loop that
 *                runs while nothing visible moves.
 *   domHealth  — a cheap snapshot (element count, duplicate ids, broken
 *                references) taken around interactions, so a menu that leaves
 *                duplicates or dangling references behind when it opens, or
 *                that adds elements every time it is opened and closed (a DOM
 *                leak), is caught.
 *
 * Everything passed to page.evaluate is self-contained.
 */
import { candidate } from '../findings.js';

export const DOM_FIX = {
	idle_dom_churn: 'Find what keeps rewriting the DOM while the page is idle (timers, polling that re-renders unchanged data, a component re-rendering on every tick). Update only what changed, batch updates, and stop work for content that is not visible.',
	offscreen_animation: 'Pause infinite animations when their element is hidden or off-screen (animation-play-state: paused, IntersectionObserver, or removing the class), and stop them under prefers-reduced-motion.',
	idle_animation_loop: 'Stop requestAnimationFrame loops when nothing is animating (cancel the frame when the animation ends, or only schedule the next frame while something changes).',
	dom_leak: 'Make sure closing the menu or panel removes what opening it created: unmount portals/overlays, reuse the same node instead of appending a new one, and remove listeners.',
	dom_invalid_after_open: 'Generate unique ids per component instance and keep aria-controls/aria-labelledby pointing at elements that exist while the panel is open.'
};

/** Element count, duplicate ids and broken id references. Runs in the page. */
function healthSnapshot() {
	const ids = new Map();
	for (const element of document.querySelectorAll('[id]')) if (!element.id.startsWith('__qase')) ids.set(element.id, (ids.get(element.id) ?? 0) + 1);
	const broken = [];
	for (const attribute of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-activedescendant']) {
		for (const element of document.querySelectorAll(`[${attribute}]`)) {
			for (const id of element.getAttribute(attribute).split(/\s+/)) if (id && !document.getElementById(id)) broken.push(`${attribute}="${id}"`);
		}
	}
	return {
		nodes: document.getElementsByTagName('*').length,
		duplicateIds: [...ids].filter(([, count]) => count > 1).map(([id]) => id),
		brokenRefs: [...new Set(broken)].slice(0, 20)
	};
}

export async function domHealth(page) {
	return page.evaluate(healthSnapshot).catch(() => undefined);
}

/** Watches an untouched page. Runs in the page; resolves after `ms`. */
async function watchIdle(ms) {
	const own = node => node?.nodeType === 1 && (node.id?.startsWith?.('__qase') || node.closest?.('[id^="__qase"]'));
	const describe = node => {
		if (!node || node.nodeType !== 1) return '';
		let text = node.tagName.toLowerCase();
		if (node.id) return `${text}#${node.id}`;
		if (node.classList?.length) text += `.${[...node.classList].slice(0, 2).join('.')}`;
		return text;
	};
	let mutations = 0;
	const targets = new Map();
	const observer = new MutationObserver(list => {
		for (const record of list) {
			const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
			if (!target || own(target)) continue;
			mutations++;
			const key = describe(target);
			targets.set(key, (targets.get(key) ?? 0) + 1);
		}
	});
	observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
	const rafBefore = window.__qase?.raf ?? 0;
	await new Promise(resolve => setTimeout(resolve, ms));
	observer.disconnect();
	const rafCalls = (window.__qase?.raf ?? 0) - rafBefore;
	const seen = element => {
		if (!element || element.nodeType !== 1 || !element.isConnected) return false;
		const style = getComputedStyle(element);
		if (style.display === 'none' || style.visibility === 'hidden') return false;
		for (let node = element; node && node.nodeType === 1; node = node.parentElement) if (Number(getComputedStyle(node).opacity) < 0.05) return false;
		const r = element.getBoundingClientRect();
		return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
	};
	const infinite = [];
	for (const animation of document.getAnimations?.() ?? []) {
		const timing = animation.effect?.getComputedTiming?.();
		if (animation.playState !== 'running' || timing?.iterations !== Infinity) continue;
		const target = animation.effect?.target;
		if (!target || own(target)) continue;
		infinite.push({ target: describe(target), name: animation.animationName || animation.transitionProperty || 'animation', visible: seen(target) });
	}
	const movingMedia = [...document.querySelectorAll('video, canvas')].some(element => seen(element) && (element.tagName !== 'VIDEO' || !element.paused));
	return {
		mutations,
		hot: [...targets].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([target, count]) => `${target} (${count})`),
		rafCalls,
		infinite: infinite.slice(0, 30),
		movingMedia,
		seconds: ms / 1000
	};
}

/**
 * Leaves the page alone for `ms` and reports DOM churn and wasted animation.
 * Returns { candidates, measured }.
 */
export async function testIdle(page, { url, viewport, ms = 2500 }) {
	const out = [];
	const measured = await page.evaluate(watchIdle, ms).catch(() => undefined);
	if (!measured) return { candidates: out, measured };
	const base = { url, viewport, steps: [`Open ${url} at the ${viewport} viewport`, `Leave the page untouched for ${measured.seconds} s`] };
	const perSecond = measured.mutations / measured.seconds;
	if (perSecond >= 40) out.push(candidate({ ...base, detector: 'page.idle_dom_churn', category: 'performance', severity: perSecond >= 200 ? 'medium' : 'low', confidence: 0.75,
		title: `The page keeps rewriting its DOM while idle (${Math.round(perSecond)} changes/s)`,
		actual: `With no user input, ${measured.mutations} DOM changes happened in ${measured.seconds} s. Most active: ${measured.hot.join(', ') || 'unknown'}. This costs CPU and battery and can reset focus, selection and screen-reader position.`,
		expected: 'An idle page changes its DOM only for real updates (a clock tick, a new message), not continuously.', fix: DOM_FIX.idle_dom_churn, data: { key: 'idle_dom_churn' } }));
	const hidden = measured.infinite.filter(item => !item.visible);
	if (hidden.length) out.push(candidate({ ...base, detector: 'page.offscreen_animation', category: 'animation', severity: hidden.length >= 5 ? 'medium' : 'low', confidence: 0.7,
		title: `${hidden.length} infinite animation${hidden.length === 1 ? ' keeps' : 's keep'} running where nobody can see ${hidden.length === 1 ? 'it' : 'them'}`,
		actual: `Running on hidden or off-screen elements: ${[...new Set(hidden.map(item => `${item.target} (${item.name})`))].slice(0, 5).join(', ')}. They use CPU/GPU and battery for nothing.`,
		expected: 'Infinite animations pause when their element is hidden or off-screen.', fix: DOM_FIX.offscreen_animation, data: { key: 'offscreen_animation' } }));
	const visibleMotion = measured.infinite.some(item => item.visible) || measured.movingMedia;
	if (measured.rafCalls >= 30 * measured.seconds && !visibleMotion) out.push(candidate({ ...base, detector: 'page.idle_animation_loop', category: 'performance', severity: 'low', confidence: 0.6,
		title: 'A JavaScript animation loop runs while nothing on screen moves',
		actual: `requestAnimationFrame was called ${measured.rafCalls} times in ${measured.seconds} s (≈${Math.round(measured.rafCalls / measured.seconds)}/s) with no visible animation, video or canvas.`,
		expected: 'Animation-frame loops stop when nothing is animating.', fix: DOM_FIX.idle_animation_loop, data: { key: 'idle_animation_loop' } }));
	return { candidates: out, measured };
}
