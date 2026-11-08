const STORAGE_KEY = 'qase.founder.reading.v1';
const MAX_ENTRIES = 12;

export function founderViewSignature(value) {
	const stable = item => Array.isArray(item) ? item.map(stable) : item && typeof item === 'object'
		? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, stable(item[key])])) : item;
	return JSON.stringify(stable(value));
}

export function founderReadingKey(session, surface) {
	return JSON.stringify([session.ownerUserId ?? 'local', session.id, surface, session.founder?.finalizedAt ?? 'pending']);
}

/** View preferences only: never stores report content, credentials or selections. */
export function createFounderReadingStore(storage) {
	let entries = [];
	const clean = item => {
		const disclosures = {};
		for (const [name, open] of Object.entries(item?.disclosures ?? {}).slice(0, 200)) if (name.length <= 256 && !['__proto__','constructor','prototype'].includes(name) && typeof open === 'boolean') disclosures[name] = open;
		return { scrollTop: Number.isFinite(item?.scrollTop) ? Math.max(0, Math.min(item.scrollTop, 100_000_000)) : 0, disclosures, section: typeof item?.section === 'string' ? item.section.slice(0, 80) : '' };
	};
	try {
		const saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
		if (saved?.version === 1 && Array.isArray(saved.entries)) entries = saved.entries.filter(item=>typeof item?.key==='string'&&item.key.length<=1024).slice(-MAX_ENTRIES).map(item=>({key:item.key,...clean(item)}));
	} catch { /* Reading remains usable when browser storage is unavailable. */ }
	return {
		get(key) {
			const item = entries.find(entry => entry?.key === key);
			return clean(item);
		},
		put(key, state) {
			entries = entries.filter(entry => entry?.key !== key);
			entries.push({ key, ...clean(state) });
			entries = entries.slice(-MAX_ENTRIES);
			try { storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, entries })); } catch { /* Keep the in-memory preference. */ }
		}
	};
}

/** Completed reports stay mounted across ordinary SSE and selection updates.
 * Scroll measurements occur in interaction/visibility callbacks, never build. */
export function createFounderReaderState({ documentRef: doc, storage } = {}) {
	const win = doc.defaultView;
	if (storage === undefined) { try { storage = win?.sessionStorage; } catch { /* private/blocked storage */ } }
	const store = createFounderReadingStore(storage), records = new Map();
	const frame = callback => win?.requestAnimationFrame ? win.requestAnimationFrame(callback) : setTimeout(callback, 0);
	function save(record) { if (record?.active) store.put(record.key, record.state); }
	function restore(record) {
		frame(() => {
			if (!record.active || !record.root.isConnected || !record.scroller.getClientRects().length) return;
			record.restoring = true;
			record.scroller.scrollTop = record.state.scrollTop;
			frame(() => { record.restoring = false; });
		});
	}
	function attach(root) {
		const scroller = root.closest('.tab-pane') ?? root;
		const record = { root, scroller, active: false };
		records.set(root, record);
		scroller.addEventListener('scroll', () => {
			if (!record.active || record.restoring || !scroller.getClientRects().length) return;
			record.state.scrollTop = scroller.scrollTop;
			clearTimeout(record.timer); record.timer = setTimeout(() => save(record), 150);
		}, { passive: true });
		root.addEventListener('toggle', event => {
			const key = event.target.dataset?.founderDisclosure;
			if (!record.active || !key || !root.contains(event.target)) return;
			record.state.disclosures[key] = event.target.open; save(record);
		}, true);
		if (win?.MutationObserver) {
			const observer = new win.MutationObserver(() => restore(record));
			observer.observe(scroller, { attributes: true, attributeFilter: ['class', 'hidden'] });
			observer.observe(doc.body, { attributes: true, attributeFilter: ['data-workspace-view', 'data-page'] });
		}
		return record;
	}
	win?.addEventListener('pagehide', () => { for (const record of records.values()) save(record); });
	return {
		update(root, session, signature, build) {
			const record = records.get(root) ?? attach(root), key = founderReadingKey(session, root.id);
			if (record.active && record.key === key && record.signature === signature && root.firstChild === record.marker) return false;
			const focused = record.active && record.key === key && root.contains(doc.activeElement) ? doc.activeElement?.dataset?.founderFocus : undefined;
			save(record); clearTimeout(record.timer);
			record.key = key; record.signature = signature; record.state = store.get(key); record.active = true;
			root.replaceChildren(); build(); record.marker = root.firstChild;
			for (const node of root.querySelectorAll('[data-founder-disclosure]')) if (Object.hasOwn(record.state.disclosures, node.dataset.founderDisclosure)) node.open = record.state.disclosures[node.dataset.founderDisclosure];
			const select = root.querySelector('[data-founder-section-choice]');
			if (select && [...select.options].some(option => option.value === record.state.section)) select.value = record.state.section;
			restore(record);
			if (focused) frame(() => {
				if (record.active && record.key === key && doc.activeElement === doc.body) [...root.querySelectorAll('[data-founder-focus]')].find(node => node.dataset.founderFocus === focused)?.focus({ preventScroll: true });
			});
			return true;
		},
		clear(root) { const record = records.get(root); save(record); if (record) { record.active = false; clearTimeout(record.timer); } root.replaceChildren(); delete root.dataset.founderRun; delete root.dataset.founderSelection; },
		rememberSection(root, section) { const record = records.get(root); if (!record?.active) return; record.state.section = section; record.state.scrollTop = record.scroller.scrollTop; save(record); },
		flush() { for (const record of records.values()) save(record); }
	};
}
