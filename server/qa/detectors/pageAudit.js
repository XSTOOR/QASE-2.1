/**
 * In-page audit. `pageAudit` is serialized into the browser with
 * page.evaluate, so it must be self-contained (no imports, no closures).
 *
 * It measures what a user actually sees: text line boxes (Range client rects)
 * rather than element boxes, and elementFromPoint to decide which element is
 * on top. That is what keeps overlap and occlusion checks precise.
 *
 * Returns { issues: [...], metrics: {...} } where each issue is
 * { kind, severity, confidence, title, actual, expected, selector, rect, examples, key }.
 */
export function pageAudit(options = {}) {
	const issues = [];
	// On emulated mobile, innerWidth grows to fit overflowing content; the real
	// device width comes from the caller.
	const vw = options.viewportWidth || window.innerWidth;
	const vh = options.viewportHeight || window.innerHeight;
	const doc = document.documentElement;
	const MAX_ITEMS = 700;

	const cssPath = element => {
		if (!element || element.nodeType !== 1) return '';
		if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) return `#${CSS.escape(element.id)}`;
		const parts = [];
		let node = element;
		while (node && node.nodeType === 1 && parts.length < 5 && node !== document.body) {
			let part = node.tagName.toLowerCase();
			if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
			const classes = [...node.classList].filter(name => /^[A-Za-z_-][\w-]{0,40}$/.test(name) && !/^(is|has)-/.test(name)).slice(0, 2);
			if (classes.length) part += `.${classes.map(CSS.escape).join('.')}`;
			const parent = node.parentElement;
			if (parent) {
				const same = [...parent.children].filter(child => child.tagName === node.tagName);
				if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
			}
			parts.unshift(part);
			node = parent;
		}
		return parts.join(' > ');
	};
	const label = element => String(element?.getAttribute?.('aria-label') || element?.innerText || element?.value || element?.alt || element?.title || element?.getAttribute?.('placeholder') || '')
		.replace(/\s+/g, ' ').trim().slice(0, 80);
	const style = element => getComputedStyle(element);
	const visible = element => {
		if (!element || element.nodeType !== 1) return false;
		if (typeof element.checkVisibility === 'function' && !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
		const s = style(element);
		if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return false;
		const r = element.getBoundingClientRect();
		return r.width > 1 && r.height > 1;
	};
	const hiddenFromUsers = element => Boolean(element.closest('[aria-hidden="true"],[hidden],[inert]'));
	const toPage = r => ({ x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) });
	const intersect = (a, b) => {
		const x = Math.max(a.left, b.left), y = Math.max(a.top, b.top);
		const right = Math.min(a.right, b.right), bottom = Math.min(a.bottom, b.bottom);
		return right > x && bottom > y ? { left: x, top: y, right, bottom, width: right - x, height: bottom - y } : null;
	};
	const fixedAncestor = element => {
		for (let node = element; node && node !== document.body; node = node.parentElement) {
			const position = style(node).position;
			if (position === 'fixed' || position === 'sticky') return node;
		}
		return null;
	};
	const transparent = color => !color || color === 'transparent' || /rgba\([^)]*,\s*0(\.0+)?\)$/.test(color);
	const add = issue => { if (issues.length < 200) issues.push(issue); };

	// ---------- Collect visible text runs and controls ----------
	const items = [];
	const walker = document.createTreeWalker(document.body ?? doc, NodeFilter.SHOW_TEXT, {
		acceptNode: node => node.nodeValue && node.nodeValue.trim().length >= 2 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
	});
	const textByParent = new Map();
	const textInControls = new Set();
	for (let node = walker.nextNode(), count = 0; node && count < 4000; node = walker.nextNode(), count++) {
		const parent = node.parentElement;
		if (!parent || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'OPTION'].includes(parent.tagName) || hiddenFromUsers(parent) || !visible(parent)) continue;
		if (parent.closest('button,[role=button],a[href],summary,label')) { textInControls.add(parent); continue; }
		const range = document.createRange();
		range.selectNodeContents(node);
		const rects = [...range.getClientRects()].filter(r => r.width > 2 && r.height > 4);
		if (!rects.length) continue;
		if (!textByParent.has(parent)) textByParent.set(parent, []);
		textByParent.get(parent).push(...rects);
	}
	for (const [element, rects] of textByParent) items.push({ element, rects, kind: 'text' });
	// Clipping, contrast and content checks also cover text inside controls.
	const allText = [...textByParent.keys(), ...textInControls];
	const controls = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[tabindex]:not([tabindex="-1"]),summary')]
		.filter(element => visible(element) && !hiddenFromUsers(element));
	for (const element of controls.slice(0, 400)) items.push({ element, rects: [element.getBoundingClientRect()], kind: 'control' });
	const limited = items.slice(0, MAX_ITEMS);

	// ---------- Overlapping text / obscured content ----------
	const reported = new Set();
	const grid = new Map();
	const cell = 120;
	limited.forEach((item, index) => {
		for (const r of item.rects) {
			for (let gx = Math.floor((r.left + scrollX) / cell); gx <= Math.floor((r.right + scrollX) / cell); gx++) {
				for (let gy = Math.floor((r.top + scrollY) / cell); gy <= Math.floor((r.bottom + scrollY) / cell); gy++) {
					const key = `${gx}:${gy}`;
					if (!grid.has(key)) grid.set(key, new Set());
					grid.get(key).add(index);
				}
			}
		}
	});
	const checked = new Set();
	for (const bucket of grid.values()) {
		const list = [...bucket];
		for (let i = 0; i < list.length; i++) {
			for (let j = i + 1; j < list.length; j++) {
				const a = limited[list[i]], b = limited[list[j]];
				const pair = list[i] < list[j] ? `${list[i]}:${list[j]}` : `${list[j]}:${list[i]}`;
				if (checked.has(pair)) continue;
				checked.add(pair);
				if (a.element === b.element || a.element.contains(b.element) || b.element.contains(a.element)) continue;
				if (a.kind === 'control' && b.kind === 'control' && (a.element.closest('label') === b.element.closest('label') && a.element.closest('label'))) continue;
				let overlap = null;
				for (const ra of a.rects) {
					for (const rb of b.rects) {
						const o = intersect(ra, rb);
						if (o && o.width >= 6 && o.height >= 5 && o.width * o.height >= 0.15 * Math.min(ra.width * ra.height, rb.width * rb.height)) { overlap = o; break; }
					}
					if (overlap) break;
				}
				if (!overlap) continue;
				const cx = overlap.left + overlap.width / 2, cy = overlap.top + overlap.height / 2;
				if (cx < 0 || cy < 0 || cx > vw || cy > vh) {
					// Off-screen overlaps are re-measured after scrolling by the engine; skip here.
					continue;
				}
				const top = document.elementFromPoint(cx, cy);
				if (!top) continue;
				const aTop = a.element.contains(top) || top.contains(a.element) && top !== document.body;
				const bTop = b.element.contains(top) || top.contains(b.element) && top !== document.body;
				const upper = aTop ? a : bTop ? b : null;
				const lower = upper === a ? b : upper === b ? a : null;
				const key = `${cssPath(a.element)}|${cssPath(b.element)}`;
				if (reported.has(key)) continue;
				if (!upper) {
					// A third element covers both; obscuring by an overlay is checked separately.
					continue;
				}
				const upperFixed = fixedAncestor(upper.element);
				if (upperFixed && upperFixed !== fixedAncestor(lower.element)) continue; // banners/headers over scrolling content
				let opaque = false;
				for (let node = upper.element; node && node !== document.body && !node.contains(lower.element); node = node.parentElement) {
					const s = style(node);
					if (!transparent(s.backgroundColor) || s.backgroundImage !== 'none') { opaque = true; break; }
				}
				reported.add(key);
				if (upper.kind === 'text' && lower.kind === 'text' && !opaque) {
					add({ kind: 'text_overlap', severity: 'high', confidence: 0.9,
						title: 'Text overlaps other text',
						actual: `"${label(a.element).slice(0, 50)}" and "${label(b.element).slice(0, 50)}" are drawn on top of each other, so both are hard to read.`,
						expected: 'Each block of text has its own space and does not collide with neighbouring text.',
						selector: cssPath(a.element), otherSelector: cssPath(b.element), rect: toPage(overlap), key: `${cssPath(a.element)}|${cssPath(b.element)}` });
				} else if (lower.kind === 'control') {
					add({ kind: 'control_obscured', severity: 'high', confidence: 0.85,
						title: `Control "${label(lower.element) || lower.element.tagName.toLowerCase()}" is covered by another element`,
						actual: `The ${lower.element.tagName.toLowerCase()} "${label(lower.element)}" is partly covered by "${label(upper.element) || cssPath(upper.element)}"; clicks on the covered area land on the wrong element.`,
						expected: 'Interactive controls are fully visible and receive their own clicks.',
						selector: cssPath(lower.element), otherSelector: cssPath(upper.element), rect: toPage(overlap), key: cssPath(lower.element) });
				} else if (opaque && lower.kind === 'text') {
					add({ kind: 'text_obscured', severity: 'medium', confidence: 0.7,
						title: 'Text is hidden behind another element',
						actual: `"${label(lower.element).slice(0, 60)}" is partly covered by "${label(upper.element).slice(0, 40) || cssPath(upper.element)}".`,
						expected: 'Readable content is not covered by other page elements.',
						selector: cssPath(lower.element), otherSelector: cssPath(upper.element), rect: toPage(overlap), key: cssPath(lower.element) });
				} else if (upper.kind === 'text' && lower.kind === 'text') {
					add({ kind: 'text_overlap', severity: 'medium', confidence: 0.6,
						title: 'Text overlaps other text',
						actual: `"${label(a.element).slice(0, 50)}" overlaps "${label(b.element).slice(0, 50)}".`,
						expected: 'Text blocks do not collide.',
						selector: cssPath(a.element), otherSelector: cssPath(b.element), rect: toPage(overlap), key: `${cssPath(a.element)}|${cssPath(b.element)}` });
				}
			}
		}
	}

	// ---------- Controls whose centre is covered (e.g. by an invisible layer) ----------
	let obscuredCount = 0;
	for (const element of controls.slice(0, 250)) {
		const r = element.getBoundingClientRect();
		if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
		const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
		const top = document.elementFromPoint(cx, cy);
		if (!top || element.contains(top) || top.contains(element) || element.closest('label')?.contains(top)) continue;
		const topFixed = fixedAncestor(top);
		if (topFixed && !fixedAncestor(element)) continue; // a sticky header covering scrolled content is expected
		const key = cssPath(element);
		if ([...reported].some(item => item.includes(key))) continue;
		if (obscuredCount++ >= 8) break;
		add({ kind: 'control_obscured', severity: 'high', confidence: 0.75,
			title: `Control "${label(element) || element.tagName.toLowerCase()}" cannot be clicked`,
			actual: `Clicking the centre of "${label(element)}" hits "${cssPath(top)}" instead, so the control does not receive the click.`,
			expected: 'The visible control is the element that receives a click on it.',
			selector: key, otherSelector: cssPath(top), rect: toPage(r), key });
	}

	// ---------- Clipped text and text spilling out of its box ----------
	let clipped = 0;
	for (const element of allText) {
		const rects = textByParent.get(element) ?? [...element.getClientRects()];
		if (clipped >= 12) break;
		const s = style(element);
		const box = element.getBoundingClientRect();
		const clipsX = ['hidden', 'clip'].includes(s.overflowX), clipsY = ['hidden', 'clip'].includes(s.overflowY);
		if (clipsX && element.scrollWidth > element.clientWidth + 2 && s.textOverflow !== 'ellipsis' && s.whiteSpace !== 'normal' || clipsY && element.scrollHeight > element.clientHeight + 3 && s.webkitLineClamp === 'none' && !s.getPropertyValue('-webkit-line-clamp').match(/\d/)) {
			if (element.clientWidth < 10 || element.clientHeight < 6) continue;
			clipped++;
			add({ kind: 'text_clipped', severity: element.matches('button,a,label,[role=button],h1,h2,h3,th') ? 'medium' : 'low', confidence: 0.75,
				title: `Text is cut off: "${label(element).slice(0, 50)}"`,
				actual: `The text needs ${element.scrollWidth}×${element.scrollHeight}px but its container shows only ${element.clientWidth}×${element.clientHeight}px with overflow hidden, so part of it is cut off.`,
				expected: 'Text wraps, grows its container, or is truncated deliberately with an ellipsis.',
				selector: cssPath(element), rect: toPage(box), key: cssPath(element) });
			continue;
		}
		// Text drawn outside a bordered/filled box (classic fixed-height button bug).
		const s2 = s;
		const boxed = !transparent(s2.backgroundColor) || parseFloat(s2.borderTopWidth) > 0 && s2.borderTopStyle !== 'none';
		if (boxed && box.width > 10 && box.height > 10) {
			const spill = rects.some(r => r.right > box.right + 4 || r.left < box.left - 4 || r.bottom > box.bottom + 4);
			if (spill) {
				clipped++;
				add({ kind: 'text_overflow_box', severity: 'medium', confidence: 0.7,
					title: `Text spills outside its box: "${label(element).slice(0, 50)}"`,
					actual: 'The text is wider or taller than the filled or bordered box drawn behind it, so it runs past the edge.',
					expected: 'Text stays inside its button, badge or card.',
					selector: cssPath(element), rect: toPage(box), key: cssPath(element) });
			}
		}
	}

	// ---------- Horizontal overflow ----------
	const scrollWidth = Math.max(doc.scrollWidth, document.body?.scrollWidth ?? 0);
	if (scrollWidth > vw + 2 && style(doc).overflowX !== 'hidden' && style(document.body).overflowX !== 'hidden') {
		const offenders = [];
		for (const element of document.body.querySelectorAll('*')) {
			if (offenders.length >= 5) break;
			const r = element.getBoundingClientRect();
			if (r.right <= vw + 2 || r.width < 4 || !visible(element)) continue;
			let scroller = false;
			for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
				if (['auto', 'scroll', 'hidden', 'clip'].includes(style(node).overflowX)) { scroller = true; break; }
			}
			if (scroller || offenders.some(item => item.element.contains(element))) continue;
			offenders.push({ element, right: Math.round(r.right) });
		}
		add({ kind: 'horizontal_overflow', severity: vw < 700 ? 'high' : 'medium', confidence: 0.9,
			title: `Page scrolls sideways at ${vw}px width`,
			actual: `The page is ${scrollWidth}px wide in a ${vw}px viewport, so users can scroll it sideways.${offenders.length ? ` Widest elements: ${offenders.map(item => `${cssPath(item.element)} (ends at ${item.right}px)`).join(', ')}.` : ''}`,
			expected: 'Content fits the viewport width; only intentional carousels or tables scroll horizontally.',
			selector: offenders[0] ? cssPath(offenders[0].element) : 'html', rect: offenders[0] ? toPage(offenders[0].element.getBoundingClientRect()) : undefined,
			examples: offenders.map(item => cssPath(item.element)), key: 'horizontal_overflow', ignoreSelector: true });
	}

	// ---------- Large fixed overlays at load ----------
	for (const element of document.body.querySelectorAll('*')) {
		const s = style(element);
		if (s.position !== 'fixed' || !visible(element)) continue;
		const r = element.getBoundingClientRect();
		const area = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
		if (area / (vw * vh) > 0.45 && element.getAttribute('role') !== 'dialog' && !element.matches('dialog,[aria-modal="true"]') && label(element).length > 0 && r.height < vh * 0.98) {
			add({ kind: 'blocking_overlay', severity: 'medium', confidence: 0.55,
				title: 'A fixed overlay covers most of the screen on load',
				actual: `"${label(element).slice(0, 60)}" is fixed in place and covers ${Math.round(area / (vw * vh) * 100)}% of the ${vw}×${vh} viewport.`,
				expected: 'Banners and prompts leave the page usable or are clearly dismissible dialogs.',
				selector: cssPath(element), rect: toPage(r), key: cssPath(element) });
			break;
		}
	}

	// ---------- Touch targets ----------
	if (options.touch) {
		// WCAG 2.5.8: an undersized target passes when a 24px circle around its
		// centre does not reach another target. Inline links in sentences are exempt.
		const centres = controls.map(element => { const r = element.getBoundingClientRect(); return { element, x: r.left + r.width / 2, y: r.top + r.height / 2, r }; });
		const small = centres.filter(({ element, x, y, r }) => {
			if (element.tagName === 'A' && element.closest('p')) return false;
			if (!((r.width < 24 || r.height < 24) && r.width > 0 && r.height > 0)) return false;
			return centres.some(other => other.element !== element && !other.element.contains(element) && !element.contains(other.element) &&
				Math.max(other.r.left - x, 0, x - other.r.right) ** 2 + Math.max(other.r.top - y, 0, y - other.r.bottom) ** 2 < 24 * 24);
		}).map(item => item.element);
		if (small.length) add({ kind: 'small_touch_targets', severity: 'low', confidence: 0.8,
			title: `${small.length} touch target${small.length === 1 ? ' is' : 's are'} smaller than 24×24px`,
			actual: `Examples: ${small.slice(0, 5).map(element => `${cssPath(element)} (${Math.round(element.getBoundingClientRect().width)}×${Math.round(element.getBoundingClientRect().height)})`).join('; ')}.`,
			expected: 'Touch targets are at least 24×24 CSS pixels (WCAG 2.5.8), ideally 44×44.',
			selector: cssPath(small[0]), examples: small.slice(0, 8).map(cssPath), key: 'small_touch_targets', siteWide: true });
	}

	// ---------- Images ----------
	const images = [...document.images];
	const broken = images.filter(image => image.complete && image.naturalWidth === 0 && visible(image) && image.currentSrc);
	for (const image of broken.slice(0, 6)) add({ kind: 'broken_image', severity: 'medium', confidence: 0.9,
		title: `Image does not load: ${image.alt || image.currentSrc.split('/').pop().slice(0, 60)}`,
		actual: `The image ${image.currentSrc.slice(0, 200)} failed to load and shows as broken.`,
		expected: 'Every visible image loads.', selector: cssPath(image), rect: toPage(image.getBoundingClientRect()), key: image.currentSrc });
	for (const image of images.filter(image => image.naturalWidth > 0 && visible(image)).slice(0, 200)) {
		const r = image.getBoundingClientRect();
		const fit = style(image).objectFit;
		if (r.width < 40 || r.height < 40 || !['fill', ''].includes(fit)) continue;
		const natural = image.naturalWidth / image.naturalHeight, rendered = r.width / r.height;
		if (Math.abs(natural - rendered) / natural > 0.18) add({ kind: 'distorted_image', severity: 'low', confidence: 0.75,
			title: `Image is stretched or squashed: ${image.alt || image.currentSrc.split('/').pop().slice(0, 60)}`,
			actual: `Natural aspect ratio ${natural.toFixed(2)} is rendered at ${rendered.toFixed(2)} (${Math.round(r.width)}×${Math.round(r.height)}).`,
			expected: 'Images keep their aspect ratio (use object-fit or set one dimension to auto).', selector: cssPath(image), rect: toPage(r), key: image.currentSrc });
	}
	const noAlt = images.filter(image => !image.hasAttribute('alt') && visible(image) && image.getBoundingClientRect().width > 20);
	if (noAlt.length) add({ kind: 'image_alt_missing', severity: 'medium', confidence: 0.9,
		title: `${noAlt.length} image${noAlt.length === 1 ? ' has' : 's have'} no alt text`,
		actual: `Screen readers announce these images without a description: ${noAlt.slice(0, 4).map(image => image.currentSrc.split('/').pop().slice(0, 50)).join(', ')}.`,
		expected: 'Informative images have alt text; decorative images use alt="".',
		selector: cssPath(noAlt[0]), examples: noAlt.slice(0, 8).map(cssPath), key: 'image_alt_missing' });

	// ---------- Accessible names and labels ----------
	const accessibleName = element => {
		const labelled = element.getAttribute('aria-labelledby');
		if (labelled && labelled.split(/\s+/).some(id => document.getElementById(id)?.textContent?.trim())) return true;
		if ((element.getAttribute('aria-label') || element.getAttribute('title') || '').trim()) return true;
		if ((element.innerText || '').trim()) return true;
		if ([...element.querySelectorAll('img[alt],svg title,svg[aria-label]')].some(item => (item.getAttribute('alt') || item.textContent || item.getAttribute('aria-label') || '').trim())) return true;
		if (element.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(element.type) && element.value) return true;
		return false;
	};
	const unnamed = controls.filter(element => element.matches('button,a[href],[role=button],[role=link],input[type=submit],input[type=button]') && !accessibleName(element));
	if (unnamed.length) add({ kind: 'control_no_name', severity: 'medium', confidence: 0.85,
		title: `${unnamed.length} button${unnamed.length === 1 ? ' or link has' : 's or links have'} no accessible name`,
		actual: `Screen readers announce these as just "button" or "link": ${unnamed.slice(0, 5).map(cssPath).join('; ')}.`,
		expected: 'Every control has visible text, aria-label or a labelled icon.', selector: cssPath(unnamed[0]), examples: unnamed.slice(0, 8).map(cssPath), key: 'control_no_name' });
	const fields = [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]),select,textarea')].filter(visible);
	const unlabeled = fields.filter(field => {
		if (field.labels?.length && [...field.labels].some(item => item.textContent.trim())) return false;
		if ((field.getAttribute('aria-label') || field.getAttribute('title') || '').trim()) return false;
		const labelled = field.getAttribute('aria-labelledby');
		return !(labelled && document.getElementById(labelled)?.textContent?.trim());
	});
	if (unlabeled.length) add({ kind: 'field_no_label', severity: 'medium', confidence: 0.85,
		title: `${unlabeled.length} form field${unlabeled.length === 1 ? ' has' : 's have'} no label`,
		actual: `Fields without a programmatic label${unlabeled.some(field => field.placeholder) ? ' (placeholder text is not a label)' : ''}: ${unlabeled.slice(0, 5).map(field => `${cssPath(field)}${field.placeholder ? ` "${field.placeholder.slice(0, 30)}"` : ''}`).join('; ')}.`,
		expected: 'Every field has a <label>, aria-label or aria-labelledby.', selector: cssPath(unlabeled[0]), examples: unlabeled.slice(0, 8).map(cssPath), key: 'field_no_label' });
	if (!doc.getAttribute('lang')) add({ kind: 'missing_lang', severity: 'low', confidence: 0.95, title: 'Page language is not declared',
		actual: 'The <html> element has no lang attribute.', expected: 'Set <html lang="…"> so assistive technology uses the right pronunciation.', selector: 'html', key: 'missing_lang', siteWide: true });
	const viewportMeta = document.querySelector('meta[name=viewport]')?.content ?? '';
	if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/i.test(viewportMeta)) add({ kind: 'zoom_disabled', severity: 'medium', confidence: 0.95,
		title: 'Pinch-zoom is disabled', actual: `The viewport meta tag is "${viewportMeta}".`, expected: 'Users can zoom to at least 200% (WCAG 1.4.4).', selector: 'meta[name=viewport]', key: 'zoom_disabled', siteWide: true });
	if (options.mobileCheck && !viewportMeta) add({ kind: 'viewport_meta_missing', severity: 'high', confidence: 0.9,
		title: 'No responsive viewport meta tag', actual: 'Mobile browsers render this page as a zoomed-out desktop page.', expected: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.', selector: 'head', key: 'viewport_meta_missing', siteWide: true });
	const ids = new Map();
	for (const element of document.querySelectorAll('[id]')) ids.set(element.id, (ids.get(element.id) ?? 0) + 1);
	const duplicateIds = [...ids].filter(([, count]) => count > 1).map(([id]) => id);
	if (duplicateIds.length) add({ kind: 'duplicate_ids', severity: 'low', confidence: 0.9, title: `${duplicateIds.length} duplicate element id${duplicateIds.length === 1 ? '' : 's'}`,
		actual: `Repeated ids: ${duplicateIds.slice(0, 8).join(', ')}. Labels, aria references and scripts may target the wrong element.`, expected: 'Element ids are unique.', selector: `#${CSS.escape(duplicateIds[0])}`, key: 'duplicate_ids' });

	// ---------- Contrast ----------
	const parseColor = value => {
		const match = String(value).match(/rgba?\(([^)]+)\)/);
		if (!match) return null;
		const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
		return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
	};
	const luminance = c => [c.r, c.g, c.b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
	const background = element => {
		for (let node = element; node; node = node.parentElement) {
			const s = style(node);
			if (s.backgroundImage !== 'none' || s.filter !== 'none' && s.filter) return null;
			const color = parseColor(s.backgroundColor);
			if (color && color.a >= 0.95) return color;
			if (color && color.a > 0.05) return null;
		}
		return { r: 255, g: 255, b: 255, a: 1 };
	};
	const lowContrast = [];
	for (const element of allText.slice(0, 400)) {
		const s = style(element);
		const fg = parseColor(s.color);
		const bg = background(element);
		if (!fg || !bg || fg.a < 0.5) continue;
		const ratio = (Math.max(luminance(fg), luminance(bg)) + 0.05) / (Math.min(luminance(fg), luminance(bg)) + 0.05);
		const size = parseFloat(s.fontSize), bold = Number(s.fontWeight) >= 700;
		const required = size >= 24 || size >= 18.66 && bold ? 3 : 4.5;
		if (ratio < required - 0.05) lowContrast.push({ element, ratio, required });
	}
	if (lowContrast.length) add({ kind: 'low_contrast', severity: lowContrast.some(item => item.ratio < 3) ? 'medium' : 'low', confidence: 0.8,
		title: `${lowContrast.length} text element${lowContrast.length === 1 ? ' has' : 's have'} insufficient colour contrast`,
		actual: `Examples: ${lowContrast.slice(0, 4).map(item => `"${label(item.element).slice(0, 30)}" ${item.ratio.toFixed(2)}:1 (needs ${item.required}:1)`).join('; ')}.`,
		expected: 'Body text has at least 4.5:1 contrast and large text 3:1 (WCAG 1.4.3).', selector: cssPath(lowContrast[0].element),
		examples: lowContrast.slice(0, 8).map(item => cssPath(item.element)), rect: toPage(lowContrast[0].element.getBoundingClientRect()), key: 'low_contrast' });

	// ---------- Content defects ----------
	const bodyText = document.body?.innerText ?? '';
	const placeholders = [];
	for (const element of allText) {
		// Only the element's own text, so a parent does not repeat its child's match.
		const value = [...element.childNodes].filter(node => node.nodeType === 3).map(node => node.nodeValue).join(' ');
		const match = value.match(/(^|[^\w])(undefined|NaN|\[object Object\]|\{\{\s*[\w.]+\s*\}\}|Invalid Date)(?=$|[^\w])/);
		if (match && !element.closest('code,pre,textarea,kbd,samp')) placeholders.push({ element, token: match[2] });
	}
	for (const item of placeholders.slice(0, 5)) add({ kind: 'broken_text', severity: 'medium', confidence: 0.85,
		title: `Page shows "${item.token}" instead of real content`,
		actual: `"${label(item.element).slice(0, 80)}" contains the programming placeholder "${item.token}".`,
		expected: 'Data is rendered, or a sensible empty state is shown.', selector: cssPath(item.element), rect: toPage(item.element.getBoundingClientRect()), key: `${item.token}:${cssPath(item.element)}` });
	if (/lorem ipsum/i.test(bodyText)) add({ kind: 'placeholder_copy', severity: 'low', confidence: 0.9, title: 'Placeholder "Lorem ipsum" copy is visible',
		actual: 'The page still contains Lorem ipsum filler text.', expected: 'Real copy replaces placeholder text before release.', selector: 'body', key: 'lorem' });
	const imagesVisible = images.some(visible);
	if (bodyText.trim().length < 20 && !imagesVisible && !document.querySelector('canvas,video,svg')) add({ kind: 'blank_page', severity: 'high', confidence: 0.8,
		title: 'Page renders blank', actual: `The page shows almost no content (${bodyText.trim().length} characters of text).`, expected: 'The page renders its content.', selector: 'body', key: 'blank_page' });
	if (!document.title.trim()) add({ kind: 'missing_title', severity: 'low', confidence: 0.95, title: 'Page has no title', actual: 'The <title> element is empty or missing.',
		expected: 'Each page has a descriptive title (shown in tabs, bookmarks and search results).', selector: 'title', key: 'missing_title' });
	const headings = [...document.querySelectorAll('h1')].filter(visible);
	if (!headings.length && bodyText.length > 200) add({ kind: 'missing_h1', severity: 'info', confidence: 0.7, title: 'Page has no visible top-level heading',
		actual: 'No visible <h1> element.', expected: 'Each page has one <h1> describing its content.', selector: 'body', key: 'missing_h1' });
	for (const anchor of [...document.querySelectorAll('a[href^="#"]')].slice(0, 200)) {
		const id = decodeURIComponent(anchor.getAttribute('href').slice(1));
		if (id && id !== 'top' && !document.getElementById(id) && !document.getElementsByName(id).length && visible(anchor) && !anchor.getAttribute('role') && !anchor.hasAttribute('data-toggle') && !anchor.hasAttribute('data-bs-toggle')) {
			add({ kind: 'broken_anchor', severity: 'low', confidence: 0.7, title: `In-page link "${label(anchor).slice(0, 40)}" points to a missing section`,
				actual: `The link targets #${id}, but no element has that id.`, expected: 'In-page links scroll to an existing section.', selector: cssPath(anchor), key: `anchor:${id}` });
			break;
		}
	}

	// ---------- Metrics from the init-script observers ----------
	const observed = window.__qase ?? {};
	const navigation = performance.getEntriesByType('navigation')[0];
	const resources = performance.getEntriesByType('resource');
	const metrics = {
		viewport: { width: vw, height: vh },
		scrollHeight: doc.scrollHeight,
		textElements: textByParent.size,
		controls: controls.length,
		forms: document.forms.length,
		images: images.length,
		loadMs: navigation ? Math.round(navigation.loadEventEnd || navigation.domContentLoadedEventEnd) : undefined,
		domContentLoadedMs: navigation ? Math.round(navigation.domContentLoadedEventEnd) : undefined,
		transferBytes: resources.reduce((sum, item) => sum + (item.transferSize || 0), navigation?.transferSize || 0),
		largeResources: resources.filter(item => (item.transferSize || item.encodedBodySize || 0) > 1_000_000).slice(0, 5).map(item => ({ url: item.name, bytes: item.transferSize || item.encodedBodySize })),
		lcpMs: observed.lcp ? Math.round(observed.lcp) : undefined,
		cls: observed.cls !== undefined ? Math.round(observed.cls * 1000) / 1000 : undefined,
		shiftSources: (observed.shiftSources ?? []).slice(0, 5),
		longTasks: (observed.longTasks ?? []).length,
		longestTaskMs: Math.round(Math.max(0, ...(observed.longTasks ?? []))),
		mixedContent: resources.filter(item => location.protocol === 'https:' && item.name.startsWith('http:')).slice(0, 5).map(item => item.name),
		title: document.title,
		metaDescription: Boolean(document.querySelector('meta[name=description]')?.content?.trim()),
		links: [...document.querySelectorAll('a[href]')].map(anchor => ({ href: anchor.href, text: label(anchor), rel: anchor.rel, target: anchor.target })).slice(0, 400),
		blankTargets: [...document.querySelectorAll('a[target=_blank]')].filter(anchor => !/noopener|noreferrer/i.test(anchor.rel) && anchor.href.startsWith('http') && new URL(anchor.href).origin !== location.origin).length
	};
	return { issues, metrics };
}

/**
 * Init script: records layout shifts (with sources), LCP and long tasks from
 * page start. Runs before any page script in every frame of the context.
 */
export const OBSERVER_SCRIPT = `(() => {
  if (window.__qase) return;
  const state = window.__qase = { cls: 0, lcp: 0, longTasks: [], shiftSources: [], frames: [], animations: [] };
  const describe = node => {
    if (!node || node.nodeType !== 1) return '';
    let text = node.tagName.toLowerCase();
    if (node.id) text += '#' + node.id;
    else if (node.classList && node.classList.length) text += '.' + [...node.classList].slice(0, 2).join('.');
    return text;
  };
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) continue;
        state.cls += entry.value;
        if (entry.value > 0.02 && state.shiftSources.length < 20) {
          state.shiftSources.push({ value: Math.round(entry.value * 1000) / 1000, at: Math.round(entry.startTime), nodes: (entry.sources || []).slice(0, 3).map(source => describe(source.node)).filter(Boolean) });
        }
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
  try { new PerformanceObserver(list => { for (const entry of list.getEntries()) state.lcp = entry.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch {}
  try { new PerformanceObserver(list => { for (const entry of list.getEntries()) if (state.longTasks.length < 200) state.longTasks.push(entry.duration); }).observe({ type: 'longtask', buffered: true }); } catch {}
})();`;
