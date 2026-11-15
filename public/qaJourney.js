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
	const submit = $('qa-submit');
	const nextButton = $('journey-next');
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
		nextButton.hidden = step === 2;
		nextButton.className = step === 1 ? 'btn btn-primary' : 'btn btn-ghost';
		nextButton.textContent = step === 0 ? 'Customize checks' : 'Review test run';
		$('qa-start').querySelector('.modal-body').scrollTop = 0;
		sync(); changed();
		panels[step].querySelector('h2')?.focus({ preventScroll: true });
	}
	function sync() {
		const state = getState();
		const ready = Boolean(state.config?.ready);
		const blocked = state.coverageBlocked || state.blocked;
		const normalized = normalizeWebsite(target.value);
		submit.hidden = step === 1;
		submit.disabled = Boolean(state.busy || !ready || blocked || !normalized);
		$('journey-review-url').textContent = normalized || 'Add a website';
		$('journey-review-checks').textContent = `${state.checks} selected`;
		$('journey-review-devices').textContent = state.environmentLabel || state.browserLabel || 'Choose one browser and one device';
		$('journey-review-model').textContent = state.config?.model || 'Provided by Qase';
		const writes = $('qa-allow-test-writes');
		if ($('journey-review-access')) $('journey-review-access').textContent = writes?.checked ? 'Reads, local input checks and marked test records (up to 10 submissions)' : 'Reads and local input checks; no test-record submissions';
		const goal = $('qa-goal').value.trim();
		$('journey-review-goal-row').hidden = !goal;
		$('journey-review-goal').textContent = goal;
		const reason = state.busy ? 'Creating your run…'
			: blocked || (!ready ? 'Qase’s model service is unavailable. Your test setup is preserved.'
				: step === 1 ? 'One browser configuration will run.'
				: 'Qase will discover the application and save evidence from executed checks.');
		if (reason !== lastAnnouncement) { $('journey-footer-hint').textContent = reason; lastAnnouncement = reason; }
		nextButton.disabled = Boolean(state.busy) || (step === 1 && Boolean(blocked));
		$('journey-back').disabled = Boolean(state.busy);
		$('qa-launch-sqa').disabled = Boolean(state.busy);
		$('qa-launch-founder').disabled = Boolean(state.busy);
		steps.forEach(button => { button.disabled = Boolean(state.busy); });
	}
	steps.forEach(button => button.addEventListener('click', () => go(Number(button.dataset.journeyStep))));
	form.querySelectorAll('[data-journey-edit]').forEach(button => button.addEventListener('click', () => go(Number(button.dataset.journeyEdit), false)));
	nextButton.addEventListener('click', () => go(step + 1));
	$('journey-back').addEventListener('click', () => go(step - 1, false));
	target.addEventListener('blur', () => { normalize(); changed(); });
	target.addEventListener('input', () => target.setCustomValidity(''));
	$('qa-goal').addEventListener('input', sync);
	$('qa-allow-test-writes')?.addEventListener('change', sync);
	form.addEventListener('submit', event => {
		if (step === 1) {
			event.preventDefault();
			event.stopImmediatePropagation();
			go(2);
			return;
		}
		const valid = normalize();
		if (!valid || submit.disabled) {
			event.preventDefault();
			event.stopImmediatePropagation();
			if (!valid) { go(0, false); target.reportValidity(); target.focus(); }
		}
	}, true);
	form.addEventListener('invalid', event => {
		if (event.target.closest('[data-journey-panel="1"]') && step !== 1) go(1, false);
		else if (event.target === target && step !== 0) go(0, false);
	}, true);
	return {
		start() { go(0, false); },
		sync,
		showCoverage() { go(1, false); },
		get step() { return step; }
	};
}
