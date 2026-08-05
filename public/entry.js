/*
 * Qase cinematic entry and owner authentication.
 *
 * This module keeps the existing visual transitions, but the workspace handoff
 * now happens only after the server confirms an HttpOnly authenticated session.
 * The dashboard waits on `qaseAuthReady`, so it cannot touch protected APIs
 * while the entry layer is still locked.
 */

const entry = document.getElementById('entry-experience');

let resolveAuthReady;
window.qaseAuth = { authenticated: false, configured: false };
window.qaseAuthReady = new Promise(resolve => {
	resolveAuthReady = resolve;
});

if (entry) {
	const welcome = document.getElementById('entry-welcome');
	const auth = document.getElementById('entry-auth');
	const beginButton = document.getElementById('entry-begin');
	const backButton = document.getElementById('entry-back');
	const emailInput = document.getElementById('entry-email');
	const passwordInput = document.getElementById('entry-password');
	const confirmInput = document.getElementById('entry-password-confirm');
	const confirmField = document.getElementById('auth-confirm-field');
	const setupTokenInput = document.getElementById('entry-setup-token');
	const setupTokenField = document.getElementById('auth-setup-token-field');
	const rememberInput = document.getElementById('entry-remember');
	const authForm = document.getElementById('entry-auth-form');
	const authTitle = document.getElementById('auth-title');
	const authKicker = document.querySelector('.auth-kicker');
	const authDescription = document.querySelector('.auth-heading > p:last-child');
	const authSubmit = document.getElementById('auth-submit');
	const authSubmitLabel = document.getElementById('auth-submit-label');
	const authMessage = document.getElementById('auth-message');
	const authAccountNote = document.getElementById('auth-account-note');
	const authSecurityCopy = document.getElementById('auth-security-copy');
	const indexLabel = document.getElementById('entry-index');
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
	let submitting = false;
	let activeView = 'welcome';
	let authMode = 'login';
	let authStatus;
	let statusRequest;
	let authResolved = false;
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

	function setScreenActive(screen, active) {
		screen.toggleAttribute('inert', !active);
		if (active) screen.removeAttribute('aria-hidden');
		else screen.setAttribute('aria-hidden', 'true');
	}

	function focusWithoutScroll(control) {
		control?.focus({ preventScroll: true });
	}

	function setAuthMessage(message = '', kind = '') {
		authMessage.textContent = message;
		authMessage.className = `auth-message${kind ? ` is-${kind}` : ''}`;
		authMessage.setAttribute('role', kind === 'error' ? 'alert' : 'status');
		authMessage.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
	}

	function setAuthMode(mode) {
		authMode = mode;
		const setup = mode === 'setup';
		const requiresSetupToken = setup && Boolean(authStatus?.setupTokenRequired);
		authTitle.textContent = setup ? 'Create owner account' : 'Welcome back';
		authKicker.textContent = setup ? 'Secure this instance' : 'Mission control';
		authDescription.textContent = setup
			? 'Create the single owner account for this Qase workspace.'
			: 'Sign in to continue to your QA workspace.';
		authSubmitLabel.textContent = setup ? 'Create account' : 'Sign in';
		authAccountNote.textContent = setup
			? 'Use at least 12 characters. Your password is never stored in plain text.'
			: 'This Qase instance is restricted to its owner account.';
		if (authSecurityCopy) {
			authSecurityCopy.textContent = setup
				? 'Protected with a one-way scrypt password hash.'
				: 'Protected by a secure server-side session.';
		}
		confirmField.hidden = !setup;
		confirmInput.required = setup;
		if (!setup) confirmInput.value = '';
		setupTokenField.hidden = !requiresSetupToken;
		setupTokenInput.required = requiresSetupToken;
		if (!requiresSetupToken) setupTokenInput.value = '';
		passwordInput.autocomplete = setup ? 'new-password' : 'current-password';
		setAuthMessage();
	}

	function updateView(view) {
		activeView = view;
		entry.dataset.view = view;
		entry.setAttribute('aria-labelledby', view === 'auth' ? 'auth-title' : 'entry-title');
		setScreenActive(welcome, view === 'welcome');
		setScreenActive(auth, view === 'auth');
		indexLabel.textContent = view === 'auth' ? '02 / 02' : '01 / 02';
	}

	async function authRequest(path, options = {}) {
		const response = await fetch(`/api/auth${path}`, {
			credentials: 'same-origin',
			headers: { Accept: 'application/json', ...(options.headers ?? {}) },
			...options
		});
		const body = response.status === 204 ? undefined : await response.json().catch(() => ({}));
		if (!response.ok) {
			const error = new Error(body?.error ?? `Authentication request failed (${response.status}).`);
			error.status = response.status;
			throw error;
		}
		return body;
	}

	function getAuthStatus(refresh = false) {
		if (!statusRequest || refresh) {
			statusRequest = authRequest('/session').then(result => {
				authStatus = result;
				return result;
			}).finally(() => {
				statusRequest = undefined;
			});
		}
		return statusRequest;
	}

	async function showAuth() {
		if (transitioning || activeView === 'auth') return;

		transitioning = true;
		beginButton.disabled = true;
		authSubmit.disabled = true;
		entry.classList.add('is-warping');
		announcer.textContent = 'Preparing secure Qase sign-in.';

		try {
			const session = authStatus ?? await getAuthStatus();
			if (session.authenticated) {
				await completeAuthentication(session);
				return;
			}
			setAuthMode(session.configured ? 'login' : 'setup');
		} catch (error) {
			setAuthMode('login');
			setAuthMessage(error instanceof Error ? error.message : String(error), 'error');
		}

		const switchDelay = reducedMotion.matches ? 0 : 410;
		const finishDelay = reducedMotion.matches ? 0 : 860;

		window.setTimeout(() => {
			updateView('auth');
			focusWithoutScroll(emailInput);
		}, switchDelay);
		window.setTimeout(() => {
			entry.classList.remove('is-warping');
			beginButton.disabled = false;
			authSubmit.disabled = false;
			transitioning = false;
		}, finishDelay);
	}

	function showWelcome() {
		if (transitioning || submitting || activeView === 'welcome') return;

		transitioning = true;
		updateView('welcome');
		setAuthMessage();
		passwordInput.value = '';
		confirmInput.value = '';
		focusWithoutScroll(beginButton);
		announcer.textContent = 'Returned to the Qase welcome screen.';

		window.setTimeout(() => {
			transitioning = false;
		}, reducedMotion.matches ? 0 : 650);
	}

	function revealWorkspace(immediate = false) {
		if (entry.hidden) return Promise.resolve();
		transitioning = true;
		if (!immediate) entry.classList.add('is-leaving');
		announcer.textContent = 'Authentication complete. Opening the Qase workspace.';

		return new Promise(resolve => {
			window.setTimeout(() => {
				entry.hidden = true;
				entry.setAttribute('aria-hidden', 'true');
				entry.removeAttribute('aria-modal');
				document.documentElement.classList.remove('entry-active');
				setWorkspaceLocked(false);
				transitioning = false;
				focusWithoutScroll(document.getElementById('composer-input'));
				resolve();
			}, immediate || reducedMotion.matches ? 0 : 650);
		});
	}

	async function completeAuthentication(session, immediate = false) {
		authStatus = session;
		window.qaseAuth = session;
		await revealWorkspace(immediate);
		if (!authResolved) {
			authResolved = true;
			resolveAuthReady(session);
		}
	}

	async function submitAuthentication(event) {
		event.preventDefault();
		if (transitioning || submitting || !authForm.reportValidity()) return;

		if (authMode === 'setup' && passwordInput.value !== confirmInput.value) {
			confirmInput.setCustomValidity('Passwords do not match.');
			confirmInput.reportValidity();
			confirmInput.setCustomValidity('');
			setAuthMessage('Passwords do not match.', 'error');
			return;
		}

		submitting = true;
		authSubmit.disabled = true;
		backButton.disabled = true;
		authForm.setAttribute('aria-busy', 'true');
		authSubmit.classList.add('is-loading');
		authSubmitLabel.textContent = authMode === 'setup' ? 'Creating account…' : 'Signing in…';
		setAuthMessage(authMode === 'setup' ? 'Securing your workspace…' : 'Verifying your session…');

		try {
			const headers = { 'Content-Type': 'application/json' };
			if (authMode === 'setup' && setupTokenInput.value) {
				headers['X-Qase-Setup-Token'] = setupTokenInput.value;
			}
			const session = await authRequest(authMode === 'setup' ? '/setup' : '/login', {
				method: 'POST',
				headers,
				body: JSON.stringify({
					email: emailInput.value.trim(),
					password: passwordInput.value,
					remember: rememberInput.checked
				})
			});
			passwordInput.value = '';
			confirmInput.value = '';
			setAuthMessage('Authenticated. Opening your workspace…', 'success');
			await completeAuthentication(session);
		} catch (error) {
			if (authMode === 'setup' && error?.status === 409) {
				const latest = await getAuthStatus(true).catch(() => undefined);
				if (latest?.configured) setAuthMode('login');
			}
			setAuthMessage(error instanceof Error ? error.message : String(error), 'error');
			passwordInput.select();
		} finally {
			submitting = false;
			authSubmit.disabled = false;
			backButton.disabled = false;
			authForm.removeAttribute('aria-busy');
			authSubmit.classList.remove('is-loading');
			if (!entry.hidden) authSubmitLabel.textContent = authMode === 'setup' ? 'Create account' : 'Sign in';
		}
	}

	function activeFocusables() {
		const screen = activeView === 'auth' ? auth : welcome;
		return [...screen.querySelectorAll(
			'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
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

		if (event.key === 'Escape' && activeView === 'auth' && !submitting) {
			event.preventDefault();
			showWelcome();
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

		particleLayer.append(fragment);
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

	async function initialiseAuthentication() {
		try {
			const session = await getAuthStatus();
			if (session.authenticated) {
				await completeAuthentication(session, true);
				return;
			}
			setAuthMode(session.configured ? 'login' : 'setup');
		} catch {
			// The entry stays usable. A precise network error is shown if the user
			// opens or submits the auth form while the server is unavailable.
			setAuthMode('login');
		}
		window.requestAnimationFrame(() => focusWithoutScroll(beginButton));
	}

	document.documentElement.classList.add('entry-active');
	setWorkspaceLocked(true);
	updateView('welcome');
	addParticles();

	beginButton.addEventListener('click', () => void showAuth());
	backButton.addEventListener('click', showWelcome);
	authForm.addEventListener('submit', event => void submitAuthentication(event));
	document.addEventListener('keydown', guardEntryKeyboard, true);
	document.addEventListener('focusin', keepFocusInside, true);
	entry.addEventListener('pointermove', handlePointerMove, { passive: true });
	entry.addEventListener('pointerleave', resetParallax, { passive: true });
	window.addEventListener('qase:auth-expired', () => window.location.reload(), { once: true });

	void initialiseAuthentication();
} else {
	resolveAuthReady(window.qaseAuth);
}
