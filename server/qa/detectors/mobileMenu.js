const expected = 'Opening the menu reveals navigation links. Closing it hides those links again.';
const controls = 'button, [role="button"], summary';

async function findTrigger(page) {
	const buttons = page.locator(controls);
	const index = await buttons.evaluateAll(nodes => nodes.findIndex(button => {
		if (button.closest('form') || button.matches('[disabled], [aria-disabled=true]') || !button.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
		const name = [button.getAttribute('aria-label'), button.title, button.innerText, button.className, button.id].join(' ');
		const ownsNav = (button.getAttribute('aria-controls') || '').split(/\s+/).some(id => id && document.getElementById(id)?.matches('nav, [role=navigation]'));
		return /hamburger|burger|navigation|\bmenu\b|☰/i.test(name) && !/account|profile|user.menu|context.menu|more.options/i.test(name)
			|| Boolean(ownsNav && button.closest('header,nav,[role=navigation]'));
	}));
	return index < 0 ? undefined : buttons.nth(index).elementHandle({ timeout: 1500 });
}

// Count links that can actually receive a tap. CSS visibility alone also
// counts off-screen drawers and links covered by an overlay.
function observePanel({ ids, region }) {
	const panels = (ids.length ? ids.map(id => document.getElementById(id)) : [region]).filter(panel => panel?.isConnected);
	const candidates = new Set(panels.flatMap(panel => Array.from(panel.querySelectorAll('a[href], [role=menuitem]'))));
	const links = [...candidates].filter(link => {
		if (!link.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || link.closest('[inert]')) return false;
		for (const rect of link.getClientRects()) {
			const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
			const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
			if (right > left && bottom > top && link.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2))) return true;
		}
		return false;
	});
	return { links: links.length, exists: panels.length > 0 };
}

async function waitForLinks(page, panel, opening) {
	const until = Date.now() + 2200;
	let observed;
	let stableSince;
	do {
		observed = await page.evaluate(observePanel, panel);
		if ((observed.links > 0) === opening) {
			stableSince ??= Date.now();
			if (Date.now() - stableSince >= 180) return { ...observed, stable: true };
		} else stableSince = undefined;
		await page.waitForTimeout(75);
	} while (Date.now() < until);
	return { ...observed, stable: false };
}

export async function checkMobileMenu(page, { browser, save, stopped = () => false }) {
	const result = { name: 'Mobile navigation menu', expected, evidence: [], status: 'inconclusive' };
	const finish = (status, detail) => Object.assign(result, { status, detail });
	const capture = async label => {
		const bytes = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 2000 }).catch(() => undefined);
		const artifactId = bytes && await save(bytes, 'Mobile menu · ' + label);
		if (artifactId) result.evidence.push({ label, artifactId });
	};
	try {
		const trigger = await findTrigger(page);
		if (!trigger) return finish('not_applicable', 'No visible mobile navigation toggle was identified.');
		const url = page.url();
		const restrictionsAffect = (before, transitionVerified) => {
			const now = browser.blocked?.(page) ?? {};
			const increased = kind => (now[kind] ?? 0) > (before[kind] ?? 0);
			// A blocked background write cannot invalidate a directly observed UI
			// transition. Preserve uncertainty when the expected state is missing.
			return increased('navigation') || increased('offsite_navigation') || !transitionVerified && (increased('write_blocked') || increased('policy'));
		};
		const { id, label, expanded } = await trigger.evaluate(el => ({
			id: el.getAttribute('aria-controls')?.trim(), label: (el.getAttribute('aria-label') || el.innerText || el.title || el.id || 'Menu').trim().slice(0, 100),
			expanded: el.getAttribute('aria-expanded')
		}));
		result.control = label;
		const region = id ? null : await trigger.evaluateHandle(el => {
			if (el.matches('summary')) return el.closest('details');
			const owner = el.closest('header, nav, [role=navigation]');
			const panels = owner?.querySelectorAll('nav, [role=navigation], [role=menu], ul');
			return owner?.matches('nav,[role=navigation]') ? owner : panels?.length === 1 ? panels[0] : null;
		});
		const panel = { ids: id ? id.split(/\s+/) : [], region };
		const before = await page.evaluate(observePanel, panel);
		if (!id && !before.exists) return finish('inconclusive', 'A toggle was found, but its navigation panel could not be identified.');
		if (expanded === 'true' || before.links) return finish('inconclusive', 'The navigation did not start with its links hidden.');
		await browser.hideCursor?.(page);
		await capture('Before opening');
		const click = handle => browser.interact(() => browser.activate(handle, { timeout: 2500 }, page));
		if (stopped()) return finish('inconclusive', 'Run stopped before opening the menu.');
		const beforeOpen = browser.blocked?.(page) ?? {};
		await click(trigger);
		const open = await waitForLinks(page, panel, true);
		await capture('After opening');
		if (restrictionsAffect(beforeOpen, open.stable && open.links > 0)) return finish('inconclusive', 'A browser restriction occurred while verifying the opening action.');
		if (page.url() !== url) return finish('inconclusive', 'The control navigated away from the entry page.');
		if (!open.links) return finish('failed', 'Opening the menu exposed no tappable navigation links.');
		if (!open.stable) return finish('inconclusive', 'Navigation links appeared briefly but did not settle before the observation ended.');
		if (stopped()) return finish('inconclusive', 'Navigation links appeared. The run stopped before closing the menu.');
		let close = trigger;
		if (!await trigger.isVisible()) {
			const closeButtons = page.getByRole('button', { name: /^(close|hide)( (the )?(navigation|main|mobile|menu|drawer))*$/i }).filter({ visible: true });
			if (await closeButtons.count() !== 1) return finish('inconclusive', 'Links appeared, but a unique close button could not be identified.');
			close = closeButtons.first();
		}
		const beforeClose = browser.blocked?.(page) ?? {};
		await click(close);
		const closed = await waitForLinks(page, panel, false);
		await capture('After closing');
		if (restrictionsAffect(beforeClose, closed.stable && closed.links === 0)) return finish('inconclusive', 'A browser restriction occurred while verifying the closing action.');
		if (page.url() !== url || (!id && !closed.exists)) return finish('inconclusive', 'The original navigation panel could no longer be verified.');
		if (!closed.links && !closed.stable) return finish('inconclusive', 'The links disappeared too late to confirm that the menu stayed closed.');
		return closed.links ? finish('failed', closed.links + ' navigation links remained tappable after closing.')
			: finish('passed', 'Tappable navigation links before opening, after opening and after closing: 0 → ' + open.links + ' → 0.');
	} catch {
		return finish('inconclusive', 'The browser could not complete or observe the menu interaction.');
	}
}
