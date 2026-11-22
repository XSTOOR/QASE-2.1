/**
 * Blocking overlays: product tours, welcome modals, cookie banners, promo
 * pop-ups. They sit on top of the app and swallow every click, so an agent
 * that does not clear them tests nothing. Nothing here is site specific: an
 * overlay is anything modal-looking (dialog roles, aria-modal, or a fixed
 * layer covering the middle of the viewport), and it is dismissed only with
 * its own non-committal controls (Skip, Close, Not now, Reject…) or Escape.
 *
 * Privacy: for consent banners the most privacy-preserving choice is taken
 * (reject / only necessary); "accept" is never clicked.
 */

const DISMISS = /^(skip( tour| for now)?|close|dismiss|no,? thanks|not now|maybe later|later|got it|ok(ay)?|continue|×|✕|✖|x|cancel|done|reject( all)?|decline|only (necessary|essential)|necessary only|use necessary cookies only|don'?t allow|block)$/i;
const NEVER = /\b(accept|agree|allow all|subscribe|sign ?up|buy|upgrade|start (free )?trial|delete|remove|log ?out|sign ?out|pay)\b/i;

/** Finds blocking overlays and the safe control that closes each. Runs in the page. */
function scanOverlays({ dismiss, never, includeToasts = false }) {
	const dismissRe = new RegExp(dismiss, 'i');
	const neverRe = new RegExp(never, 'i');
	const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 40 && r.height > 30 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
	const label = el => (el.getAttribute('aria-label') || el.innerText || el.value || el.title || '').replace(/\s+/g, ' ').trim();
	const candidates = new Set([...document.querySelectorAll('[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open], [class*=modal i], [class*=tour i], [class*=popover i], [class*=cookie i], [id*=cookie i], [class*=consent i], [class*=toast i], [class*=banner i], [role=alert], [role=status], [aria-live]')].filter(visible));
	if (includeToasts) {
		// Floating notices (fixed position, with their own Dismiss/Close) cover controls too.
		let scanned = 0;
		for (const el of document.body?.querySelectorAll('*') ?? []) {
			if (++scanned > 4000) break;
			const st = getComputedStyle(el);
			if (st.position !== 'fixed' || !visible(el) || el.closest('[data-qase-ignore]')) continue;
			const r = el.getBoundingClientRect();
			if (r.width * r.height > innerWidth * innerHeight * 0.4) continue;
			if ([...el.querySelectorAll('button, [role=button]')].some(b => dismissRe.test(label(b)) && !neverRe.test(label(b)))) candidates.add(el);
		}
	}
	// A fixed layer covering the centre of the viewport is modal even without semantics.
	const centre = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
	for (let el = centre; el && el !== document.body; el = el.parentElement) {
		const s = getComputedStyle(el);
		if ((s.position === 'fixed' || s.position === 'sticky') && Number(s.zIndex) >= 10 && visible(el)) { candidates.add(el); break; }
	}
	const out = [];
	let index = 0;
	for (const overlay of candidates) {
		if ([...candidates].some(other => other !== overlay && other.contains(overlay) && candidates.has(other))) continue;
		const controls = [...overlay.querySelectorAll('button, [role=button], a, input[type=button], input[type=submit]')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; });
		const named = controls.map(el => ({ el, text: label(el) }));
		const close = named.find(item => dismissRe.test(item.text) && !neverRe.test(item.text))
			?? named.find(item => /close|dismiss/i.test(item.el.getAttribute('aria-label') ?? '') || /close|dismiss/i.test(item.el.className?.toString?.() ?? ''));
		const r = overlay.getBoundingClientRect();
		const modal = overlay.matches('[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open]') || (r.width * r.height > innerWidth * innerHeight * 0.08 && r.left < innerWidth / 2 && r.right > innerWidth / 2);
		if (!modal && !close) continue;
		const consent = overlay.matches('[class*=cookie i], [id*=cookie i], [class*=consent i]') || /cookie|consent/i.test(label(overlay).slice(0, 300));
		if (!modal && !consent && !includeToasts) continue; // notices are left alone during audits (they can be findings)
		const id = `qov${index++}`;
		if (close) close.el.setAttribute('data-qase-dismiss', id);
		out.push({ id, text: label(overlay).slice(0, 120), close: close?.text?.slice(0, 40), modal });
	}
	return out;
}

/**
 * Dismisses overlays on the page (up to `rounds` layers: tours often stack).
 * Returns what was dismissed, for the run log.
 */
export async function dismissOverlays(page, { rounds = 3, cursor, includeToasts = false } = {}) {
	const dismissed = [];
	for (let round = 0; round < rounds; round++) {
		const overlays = await page.evaluate(scanOverlays, { dismiss: DISMISS.source, never: NEVER.source, includeToasts }).catch(() => []);
		const target = overlays.find(item => item.close) ?? overlays.find(item => item.modal);
		if (!target) break;
		if (target.close) {
			const control = page.locator(`[data-qase-dismiss="${target.id}"]`).first();
			if (cursor) await cursor(control, `Close "${target.close}"`).catch(() => {});
			const ok = await control.click({ timeout: 2500 }).then(() => true).catch(() => false);
			if (!ok) await page.keyboard.press('Escape').catch(() => {});
			dismissed.push(`${target.text.slice(0, 50) || 'overlay'} → ${ok ? `"${target.close}"` : 'Escape'}`);
		} else {
			await page.keyboard.press('Escape').catch(() => {});
			const still = await page.evaluate(scanOverlays, { dismiss: DISMISS.source, never: NEVER.source }).catch(() => []);
			if (still.some(item => item.text === target.text)) break; // cannot be closed safely: leave it
			dismissed.push(`${target.text.slice(0, 50) || 'overlay'} → Escape`);
		}
		await page.waitForTimeout(450);
	}
	return dismissed;
}

/** Overlays still covering the page (for the explorer's observation). */
export async function openOverlays(page) {
	return page.evaluate(scanOverlays, { dismiss: DISMISS.source, never: NEVER.source }).catch(() => []);
}
