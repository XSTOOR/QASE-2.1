/** Presentation controller for the launcher; execution remains owned by app.js. */
export function normalizeWebsite(value) {
	const text = String(value ?? '').trim();
	if (!text) return '';
	const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`;
	try {
		const url = new URL(candidate);
		if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /\s/.test(text)) return '';
		return url.toString();
	} catch { return ''; }
}

export function createQaJourney({ document, getState, changed, onBlocked }) {
	const $ = id => document.getElementById(id);
	const form = $('qa-form');
	const target = $('qa-target-url');
	const panels = [...form.querySelectorAll('[data-journey-panel]')];
	const steps = [...form.querySelectorAll('[data-journey-step]')];
	let step = 0;
	let lastAnnouncement = '';

	const normalize = () => {
		const normalized = normalizeWebsite(target.value);
		if (normalized) target.value = normalized;
		target.setCustomValidity(normalized || !target.value ? '' : 'Enter a website address, such as https://example.com.');
		return normalized;
	};
	function go(next, validate = true) {
		if (next > step && validate) {
			if (!normalize()) {
				// #17933: the URL input lives on panel 0; if the user is on a
				// later step the validity bubble renders invisibly. Jump back
				// to the Website panel so the error is seen, then report it.
				if (step !== 0) go(0, false);
				target.reportValidity(); target.focus();
				return;
			}
			const blocked = getState().coverageBlocked || getState().blocked;
			if (next > 1 && blocked) {
				// #17933: never a silent dead click. The footer hint carries
				// the reason; onBlocked also surfaces it on the form error
				// element (visible on every step) and can offer a retry.
				$('journey-footer-hint').textContent = blocked;
				lastAnnouncement = blocked;
				try { onBlocked?.(blocked); } catch { /* UI callback must not break navigation */ }
				return;
			}
		}
		step = Math.max(0, Math.min(2, next));
		panels.forEach((panel, index) => { panel.hidden = index !== step; });
		steps.forEach((button, index) => {
			if (index === step) button.setAttribute('aria-current', 'step');
			else button.removeAttribute('aria-current');
			button.dataset.complete = String(index < step);
		});
		$('qa-start').dataset.journeyStep = String(step);
		$('journey-back').hidden = step === 0;
		$('qa-cancel').hidden = step !== 0;
		$('journey-next').hidden = step === 2;
		$('qa-submit').hidden = step !== 2;
		$('journey-next').textContent = step === 0 ? 'Choose coverage →' : 'Review test run →';
		$('qa-start').querySelector('.modal-body').scrollTop = 0;
		sync(); changed();
		panels[step].querySelector('h2')?.focus({ preventScroll: true });
	}
	function sync() {
		const state = getState();
		const ready = Boolean(state.config?.ready);
		const blocked = state.coverageBlocked || state.blocked;
		$('qa-submit').hidden = step !== 2;
		$('qa-submit').disabled = Boolean(state.busy || !ready || blocked);
		$('journey-review-url').textContent = normalizeWebsite(target.value) || 'Add a website';
		$('journey-review-checks').textContent = `${state.checks} selected`;
		$('journey-review-devices').textContent = state.automatic ? 'Chrome · Default desktop · 1 run'
			: state.browserLabel || state.environmentLabel || 'Choose one browser and one device';
		$('journey-review-model').textContent = state.config?.model || 'Provided by Qase';
		const writes = $('qa-allow-test-writes');
		if ($('journey-review-access')) $('journey-review-access').textContent = writes?.checked ? 'Reads, local input checks and marked test records (up to 10 submissions)' : 'Reads and local input checks; no test-record submissions';
		const goal = $('qa-goal').value.trim();
		$('journey-review-goal-row').hidden = !goal;
		$('journey-review-goal').textContent = goal;
		$('journey-volume-note').hidden = state.configurations < 10;
		$('journey-volume-note').textContent = `${state.configurations.toLocaleString()} configurations will run separately. A broader selection takes longer and uses more model capacity. You can narrow it under Coverage.`;
		const reason = state.busy ? 'Creating your run. This may take a moment…'
			: step === 0 ? 'You can change these details before launch.'
			: step === 1 ? blocked || `${state.configurations.toLocaleString()} ${state.configurations === 1 ? 'run' : 'runs'} selected. Review before launching.`
			: !ready ? 'Qase’s model service is unavailable. Please try again later or contact support. Your test setup is preserved.' : state.blocked || 'Everything is ready. Start when you are.';
		if (reason !== lastAnnouncement) { $('journey-footer-hint').textContent = reason; lastAnnouncement = reason; }
		$('journey-next').disabled = Boolean(state.busy) || (step === 1 && Boolean(blocked));
		// #17933: a disabled Review Test Run button always carries its reason
		// in the live footer hint — disabled never means unexplained.
		if (step === 1 && blocked && !state.busy && reason !== blocked) {
			$('journey-footer-hint').textContent = blocked;
			lastAnnouncement = blocked;
		}
		$('journey-back').disabled = Boolean(state.busy);
		steps.forEach(button => { button.disabled = Boolean(state.busy); });
	}
	steps.forEach(button => button.addEventListener('click', () => go(Number(button.dataset.journeyStep))));
	form.querySelectorAll('[data-journey-edit]').forEach(button => button.addEventListener('click', () => go(Number(button.dataset.journeyEdit), false)));
	$('journey-next').addEventListener('click', () => go(step + 1));
	$('journey-back').addEventListener('click', () => go(step - 1, false));
	target.addEventListener('blur', () => { normalize(); changed(); });
	target.addEventListener('input', () => target.setCustomValidity(''));
	$('qa-goal').addEventListener('input', sync);
	$('qa-allow-test-writes')?.addEventListener('change', sync);
	form.addEventListener('submit', event => {
		if (step < 2) { event.preventDefault(); event.stopImmediatePropagation(); go(step + 1); }
	}, true);
	form.addEventListener('invalid', event => {
		if (event.target.closest('[data-journey-panel="1"]') && step !== 1) go(1, false);
		else if (event.target === target && step !== 0) go(0, false);
	}, true);
	return {
		start() { go(0, false); },
		sync,
		showCoverage() { go(1, false); $('qa-customize').open = true; },
		get step() { return step; }
	};
}
