import { firstMatrixSessionId } from './matrixLaunch.js';

export function startupPresentation(run, execution = {}) {
	execution ??= {};
	const item = run?.items?.find(i => ['RUNNING', 'QUEUED', 'PENDING'].includes(i.status)) ?? run?.items?.[0];
	const failed = ['error', 'interrupted', 'cancelled', 'done'].includes(run?.status);
	const preparing = item?.status === 'RUNNING' || item?.startupPhase === 'selecting_browser';
	return { terminal: failed, preparing, title: failed ? (run.status === 'cancelled' ? 'Test cancelled' : 'Your test needs attention')
		: preparing ? 'Preparing your test' : 'Your test is ready to start',
		detail: failed ? (run.error || item?.error || item?.reason || 'This run ended before an agent session became available. You can return to your tests and try again.')
			: preparing ? 'The browser is being prepared and the agent is connecting. Live activity will open here automatically.'
				: execution.position > 0 ? `Your test is queued (position ${execution.position}). The server is busy. It will start automatically when capacity is available.`
					: 'Your test is saved. We are waiting for execution capacity; there is no browser setting you need to change.',
		browser: item ? `${item.browser || item.browserCode || 'Browser'} · ${item.device || 'Desktop'}` : 'Selected automatically at startup' };
}

/** One generation owns all polling, recovery and navigation; leaving stops it. */
export function createRunStartupView({ container, api, openSession, back, details }) {
	let active = false, generation = 0, timer, runId, recovered = false;
	const el = (tag, className, text) => { const n = document.createElement(tag); n.className = className; if (text) n.textContent = text; return n; };
	const header = el('header', 'startup-header');
	const backButton = el('button', 'btn btn-ghost', '← Back to tests'); backButton.type = 'button'; backButton.onclick = back;
	header.append(backButton, el('span', 'startup-wordmark', 'QASE'));
	const content = el('div', 'startup-content');
	const eyebrow = el('p', 'startup-eyebrow', 'TEST STARTUP');
	const title = el('h1', 'startup-title', 'Preparing your test'); title.id = 'startup-title'; title.tabIndex = -1;
	const target = el('p', 'startup-target');
	const card = el('section', 'startup-card');
	const status = el('p', 'startup-status', 'Checking startup status…'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
	const browser = el('p', 'startup-browser');
	const note = el('p', 'startup-note', 'You can leave this page and return from Recent tests. Please don’t submit another run while this one is waiting.');
	const actions = el('div', 'startup-actions');
	const refresh = el('button', 'btn btn-primary', 'Check status'); refresh.type = 'button';
	const cancel = el('button', 'btn btn-ghost', 'Cancel queued test'); cancel.type = 'button';
	const technical = el('button', 'btn btn-ghost', 'Technical details'); technical.type = 'button'; technical.onclick = () => details?.(runId);
	actions.append(refresh, cancel, technical); card.append(status, browser, note, actions); content.append(eyebrow, title, target, card); container.replaceChildren(header, content);
	function stop() { active = false; generation++; clearTimeout(timer); container.hidden = true; }
	function schedule(token) { clearTimeout(timer); if (active && token === generation) timer = setTimeout(() => void tick(token), 2500); }
	async function tick(token) {
		try {
			const payload = await api(`/matrix-runs/${encodeURIComponent(runId)}`);
			if (!active || token !== generation) return;
			const run = payload.run ?? payload;
			const sessionId = firstMatrixSessionId(run);
			if (sessionId) { stop(); openSession(sessionId); return; }
			const view = startupPresentation(run, payload.execution);
			title.textContent = view.title; status.textContent = view.detail; target.textContent = run.targetUrl || ''; browser.textContent = view.browser;
			cancel.hidden = view.terminal || view.preparing; container.dataset.state = view.terminal ? 'attention' : 'waiting';
			// A recovered browser tab may encounter stranded work after a server restart.
			// One owner-authorized resume, never a duplicate run or an infinite retry.
			if (!view.terminal && run.kind !== 'parent' && run.items?.some(i => ['PENDING', 'QUEUED'].includes(i.status)) && payload.orchestratorActive === false && !recovered) {
				recovered = true; status.textContent = 'Reconnecting your saved test to the execution service…';
				await api(`/matrix-runs/${encodeURIComponent(runId)}/start`, { method: 'POST' });
				if (!active || token !== generation) return;
			}
			if (!view.terminal) schedule(token);
		} catch (error) {
			if (!active || token !== generation) return;
			status.textContent = `We couldn’t refresh startup status. ${error.message} Your saved test has not been duplicated.`;
			schedule(token);
		}
	}
	refresh.onclick = () => { clearTimeout(timer); void tick(++generation); };
	cancel.onclick = async () => {
		if (cancel.disabled) return;
		const id = runId; cancel.disabled = true;
		try { await api(`/matrix-runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }); if (active && id === runId) await load(id); }
		catch (error) { if (active && id === runId) status.textContent = `Cancellation was not confirmed: ${error.message}`; }
		finally { cancel.disabled = false; }
	};
	async function load(id) { stop(); active = true; runId = id; recovered = false; container.hidden = false; title.textContent = 'Preparing your test'; title.focus?.({ preventScroll: true }); status.textContent = 'Checking startup status…'; target.textContent = ''; browser.textContent = ''; await tick(generation); }
	return { load, stop };
}
