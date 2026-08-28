/*
 * Qase cinematic entry handoff.
 *
 * The workspace stays inert until the user explicitly begins the transmission.
 * This module owns only that visual handoff; the hosting Drytis instance owns
 * access and user isolation.
 */

const entry = document.getElementById('entry-experience');

let resolveEntryReady;
window.qaseEntryReady = new Promise(resolve => {
	resolveEntryReady = resolve;
});

if (entry) {
	const welcome = document.getElementById('entry-welcome');
	const beginButton = document.getElementById('entry-begin');
	const announcer = document.getElementById('entry-announcer');
	const particleLayer = document.getElementById('galaxy-particles');
	const workspace = document.querySelector('.app');
	const skipLink = document.querySelector('.skip-link');
	const settings = document.getElementById('settings');
	const toasts = document.getElementById('toasts');
	const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
	const finePointer = window.matchMedia('(pointer: fine)');
	const workspaceSurfaces = [workspace, skipLink, settings, toasts].filter(Boolean);

	let transitioning = false;
	let entryResolved = false;
	let pointerFrame = 0;
	let pointerX = 0;
	let pointerY = 0;

	function setWorkspaceLocked(locked) {
		for (const surface of workspaceSurfaces) {
			surface.toggleAttribute('inert', locked);
			if (locked) surface.setAttribute('aria-hidden', 'true');
			else surface.removeAttribute('aria-hidden');
		}
	}

	function focusWithoutScroll(control) {
		control?.focus({ preventScroll: true });
	}

	function completeEntryHandoff() {
		entry.hidden = true;
		entry.setAttribute('aria-hidden', 'true');
		entry.removeAttribute('aria-modal');
		document.documentElement.classList.remove('entry-active');
		setWorkspaceLocked(false);
		transitioning = false;
		focusWithoutScroll(document.getElementById('composer-input'));
		if (!entryResolved) {
			entryResolved = true;
			resolveEntryReady();
		}
	}

	function revealWorkspace() {
		if (transitioning || entry.hidden) return;

		transitioning = true;
		beginButton.disabled = true;
		entry.classList.add('is-warping');
		announcer.textContent = 'Opening the Qase workspace.';

		if (reducedMotion.matches) {
			entry.classList.add('is-leaving');
			completeEntryHandoff();
			return;
		}

		window.setTimeout(() => entry.classList.add('is-leaving'), 140);
		window.setTimeout(completeEntryHandoff, 800);
	}

	function activeFocusables() {
		return [...welcome.querySelectorAll(
			'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
		)].filter(control => !control.closest('[inert]') && !control.closest('[hidden]'));
	}

	function guardEntryKeyboard(event) {
		if (entry.hidden) return;

		const appShortcut = (event.metaKey || event.ctrlKey)
			&& (event.key.toLowerCase() === 'n' || event.key === ',');

		if (appShortcut) {
			event.preventDefault();
			event.stopImmediatePropagation();
			return;
		}

		if (event.key !== 'Tab') return;
		const focusables = activeFocusables();
		if (!focusables.length) return;

		const first = focusables[0];
		const last = focusables.at(-1);
		if (event.shiftKey && (document.activeElement === first || !entry.contains(document.activeElement))) {
			event.preventDefault();
			focusWithoutScroll(last);
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			focusWithoutScroll(first);
		}
	}

	function keepFocusInside(event) {
		if (!entry.hidden && !entry.contains(event.target)) {
			focusWithoutScroll(activeFocusables()[0]);
		}
	}

	function addParticles() {
		const fragment = document.createDocumentFragment();
		const particleCount = window.innerWidth < 700 ? 26 : 48;

		for (let index = 0; index < particleCount; index += 1) {
			const star = document.createElement('i');
			const x = (index * 47 + (index % 7) * 13 + 7) % 100;
			const y = (index * 61 + (index % 5) * 17 + 11) % 100;
			const size = index % 11 === 0 ? 2.1 : 0.65 + (index % 4) * 0.26;
			const opacity = 0.28 + (index % 6) * 0.105;
			const speed = 2.6 + (index % 7) * 0.48;
			const delay = -((index % 9) * 0.42);

			star.className = 'galaxy-particle';
			star.style.setProperty('--star-x', `${x}%`);
			star.style.setProperty('--star-y', `${y}%`);
			star.style.setProperty('--star-size', `${size}px`);
			star.style.setProperty('--star-opacity', opacity.toFixed(2));
			star.style.setProperty('--star-speed', `${speed.toFixed(2)}s`);
			star.style.setProperty('--star-delay', `${delay.toFixed(2)}s`);
			fragment.append(star);
		}

		particleLayer?.append(fragment);
	}

	function paintParallax() {
		pointerFrame = 0;
		entry.style.setProperty('--entry-far-x', `${(-pointerX * 4).toFixed(2)}px`);
		entry.style.setProperty('--entry-far-y', `${(-pointerY * 3).toFixed(2)}px`);
		entry.style.setProperty('--entry-near-x', `${(pointerX * 9).toFixed(2)}px`);
		entry.style.setProperty('--entry-near-y', `${(pointerY * 7).toFixed(2)}px`);
	}

	function handlePointerMove(event) {
		if (entry.hidden || reducedMotion.matches || !finePointer.matches) return;
		pointerX = Math.max(-1, Math.min(1, (event.clientX / window.innerWidth - 0.5) * 2));
		pointerY = Math.max(-1, Math.min(1, (event.clientY / window.innerHeight - 0.5) * 2));
		if (!pointerFrame) pointerFrame = window.requestAnimationFrame(paintParallax);
	}

	function resetParallax() {
		pointerX = 0;
		pointerY = 0;
		if (!pointerFrame) pointerFrame = window.requestAnimationFrame(paintParallax);
	}

	document.documentElement.classList.add('entry-active');
	setWorkspaceLocked(true);
	addParticles();

	beginButton.addEventListener('click', revealWorkspace);
	document.addEventListener('keydown', guardEntryKeyboard, true);
	document.addEventListener('focusin', keepFocusInside, true);
	entry.addEventListener('pointermove', handlePointerMove, { passive: true });
	entry.addEventListener('pointerleave', resetParallax, { passive: true });

	window.requestAnimationFrame(() => focusWithoutScroll(beginButton));
} else {
	resolveEntryReady();
}
