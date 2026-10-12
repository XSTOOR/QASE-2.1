const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const DEFAULT_PAGE_ROUTE = Object.freeze({ name: 'runs' });

export function routeHash(route = DEFAULT_PAGE_ROUTE) {
	if (route?.name === 'new-run') return '#/runs/new';
	if (route?.name === 'account') return '#/account';
	if (route?.name === 'bugs') return '#/bugs';
	if (route?.name === 'run' && RUN_ID_PATTERN.test(route.runId ?? '')) return `#/runs/${route.runId.toLowerCase()}`;
	if (route?.name === 'results' && RUN_ID_PATTERN.test(route.runId ?? '')) return `#/runs/${route.runId.toLowerCase()}/results`;
	return '#/runs';
}

export function parsePageRoute(hash = '') {
	const normalized = String(hash || '').trim();
	if (!normalized || normalized === '#' || normalized === '#/' || normalized === '#/runs' || normalized === '#/runs/') {
		return { ...DEFAULT_PAGE_ROUTE, canonical: '#/runs', valid: true };
	}
	if (/^#\/runs\/new\/?$/i.test(normalized)) return { name: 'new-run', canonical: '#/runs/new', valid: true };
	if (/^#\/account\/?$/i.test(normalized)) return { name: 'account', canonical: '#/account', valid: true };
	if (/^#\/bugs\/?$/i.test(normalized)) return { name: 'bugs', canonical: '#/bugs', valid: true };

	const resultsMatch = normalized.match(/^#\/runs\/([^/]+)\/results\/?$/i);
	if (resultsMatch && RUN_ID_PATTERN.test(resultsMatch[1])) {
		const runId = resultsMatch[1].toLowerCase();
		return { name: 'results', runId, canonical: `#/runs/${runId}/results`, valid: true };
	}
	const runMatch = normalized.match(/^#\/runs\/([^/]+)\/?$/i);
	if (runMatch && RUN_ID_PATTERN.test(runMatch[1])) {
		const runId = runMatch[1].toLowerCase();
		return { name: 'run', runId, canonical: `#/runs/${runId}`, valid: true };
	}
	return { ...DEFAULT_PAGE_ROUTE, canonical: '#/runs', valid: false };
}

export function createPageRouter({ windowObject = window, onRoute }) {
	let started = false;
	let transition = 0;
	let scheduled = false;

	const current = () => parsePageRoute(windowObject.location.hash);
	const urlFor = route => `${windowObject.location.pathname}${windowObject.location.search}${routeHash(route)}`;
	const apply = async (source = 'navigation') => {
		const token = ++transition;
		const route = current();
		if (!route.valid || windowObject.location.hash !== route.canonical) {
			windowObject.history.replaceState({ qaseRoute: true, qasePushed: false }, '', urlFor(route.valid ? route : DEFAULT_PAGE_ROUTE));
		}
		await onRoute?.(route.valid ? route : parsePageRoute('#/runs'), { source });
		return token === transition ? current() : undefined;
	};
	const scheduleApply = source => {
		if (scheduled) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			void apply(source);
		});
	};
	const onHistory = () => scheduleApply('history');

	return {
		get started() { return started; },
		current,
		async start({ applyCurrent = true } = {}) {
			if (!started) {
				started = true;
				windowObject.addEventListener('popstate', onHistory);
				windowObject.addEventListener('hashchange', onHistory);
			}
			return applyCurrent ? apply('start') : current();
		},
		stop() {
			if (!started) return;
			started = false;
			windowObject.removeEventListener('popstate', onHistory);
			windowObject.removeEventListener('hashchange', onHistory);
		},
		async navigate(route, { replace = false, applyRoute = true } = {}) {
			const hash = routeHash(route);
			const method = replace ? 'replaceState' : 'pushState';
			if (windowObject.location.hash !== hash || replace) {
				windowObject.history[method]({ qaseRoute: true, qasePushed: !replace }, '', urlFor(route));
			}
			return applyRoute ? apply(replace ? 'replace' : 'navigate') : current();
		},
		leave(fallback = DEFAULT_PAGE_ROUTE) {
			if (windowObject.history.state?.qasePushed && windowObject.history.length > 1) {
				windowObject.history.back();
				return;
			}
			void this.navigate(fallback, { replace: true });
		}
	};
}

