/*
 * Optional Studio presentation shell.
 *
 * `?studio=mock` changes layout only. It does not invent run state, bypass
 * authentication, or replace any Qase API. Project/target values are bounded
 * presentation context and are written with textContent / safe URL parsing.
 */
(function configureStudioMode() {
	const params = new URLSearchParams(window.location.search);
	const enabled = params.get('studio') === 'mock';
	document.documentElement.dataset.qaseLayout = enabled ? 'studio-mock' : 'standalone';
	const sidebarPreferenceKey = 'qase.sidebar';
	const legacySidebarPreferenceKey = 'qase.studio.sidebar';
	const contextStateKey = 'qase.studio.contextState';
	const contextWidthKey = 'qase.studio.contextWidth';
	const contextWidth = Object.freeze({ minimum: 220, default: 280, maximum: 340 });
	const normalizedContextWidth = value => {
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed >= contextWidth.minimum && parsed <= contextWidth.maximum
			? Math.round(parsed)
			: contextWidth.default;
	};
	const readPreference = (key, fallback) => {
		try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
	};
	const sidebarPreference = readPreference(
		sidebarPreferenceKey,
		readPreference(legacySidebarPreferenceKey, 'expanded')
	) === 'collapsed' ? 'collapsed' : 'expanded';
	document.documentElement.dataset.qaseSidebar = sidebarPreference;
	if (enabled) {
		const contextPreference = readPreference(contextStateKey, 'expanded') === 'collapsed' ? 'collapsed' : 'expanded';
		const savedContextWidth = normalizedContextWidth(readPreference(contextWidthKey, contextWidth.default));
		document.documentElement.dataset.studioContext = contextPreference;
		document.documentElement.style.setProperty('--studio-context-width', `${savedContextWidth}px`);
	}

	const bounded = (value, fallback, maximum) => {
		const normalized = String(value ?? '').trim();
		return (normalized || fallback).slice(0, maximum);
	};
	const safeTarget = value => {
		try {
			const target = new URL(value);
			return ['http:', 'https:'].includes(target.protocol) ? target.href : 'https://studio.drytis.ai/';
		} catch {
			return 'https://studio.drytis.ai/';
		}
	};

	const context = enabled ? Object.freeze({
		mode: 'mock-studio',
		project: bounded(params.get('project'), 'Drytis Studio', 120),
		targetUrl: safeTarget(params.get('target') ?? 'https://studio.drytis.ai/')
	}) : undefined;
	window.qaseStudioContext = context;

	window.addEventListener('DOMContentLoaded', () => {
		const sidebarToggle = document.getElementById('sidebar-collapse-toggle');
		const persistPreference = (key, value) => {
			try { localStorage.setItem(key, String(value)); } catch {}
		};
		const setSidebarState = (nextState, persist = true) => {
			const collapsed = nextState === 'collapsed';
			document.documentElement.dataset.qaseSidebar = collapsed ? 'collapsed' : 'expanded';
			if (sidebarToggle) {
				sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
				sidebarToggle.setAttribute('aria-label', collapsed ? 'Expand recent tests sidebar' : 'Collapse recent tests sidebar');
				sidebarToggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
			}
			if (persist) {
				try { localStorage.setItem(sidebarPreferenceKey, collapsed ? 'collapsed' : 'expanded'); } catch {}
			}
		};
		setSidebarState(document.documentElement.dataset.qaseSidebar, false);
		sidebarToggle?.addEventListener('click', () => {
			setSidebarState(document.documentElement.dataset.qaseSidebar === 'collapsed' ? 'expanded' : 'collapsed');
		});

		if (!enabled) return;
		const project = document.getElementById('studio-project-name');
		const target = document.getElementById('studio-project-target');
		const contextPanel = document.getElementById('studio-context');
		const toggle = document.getElementById('studio-context-toggle');
		const resizer = document.getElementById('studio-context-resizer');
		let currentContextWidth = normalizedContextWidth(readPreference(contextWidthKey, contextWidth.default));
		const setContextWidth = (nextWidth, persist = false) => {
			currentContextWidth = Math.min(contextWidth.maximum, Math.max(contextWidth.minimum, Math.round(nextWidth)));
			document.documentElement.style.setProperty('--studio-context-width', `${currentContextWidth}px`);
			resizer?.setAttribute('aria-valuenow', String(currentContextWidth));
			if (persist) persistPreference(contextWidthKey, currentContextWidth);
		};
		const setContextState = (nextState, persist = true) => {
			const collapsed = nextState === 'collapsed';
			document.documentElement.dataset.studioContext = collapsed ? 'collapsed' : 'expanded';
			if (toggle) {
				toggle.setAttribute('aria-expanded', String(!collapsed));
				toggle.setAttribute('aria-label', collapsed ? 'Show project context' : 'Hide project context');
				toggle.title = collapsed ? 'Show project context' : 'Hide project context';
			}
			if (persist) persistPreference(contextStateKey, collapsed ? 'collapsed' : 'expanded');
		};
		if (project) project.textContent = context.project;
		if (target) {
			target.href = context.targetUrl;
			target.textContent = new URL(context.targetUrl).host;
		}
		if (!contextPanel || !toggle || !resizer) return;
		setContextWidth(currentContextWidth);
		setContextState(document.documentElement.dataset.studioContext, false);
		toggle.addEventListener('click', () => {
			setContextState(document.documentElement.dataset.studioContext === 'collapsed' ? 'expanded' : 'collapsed');
		});

		let pointerStartLeft = 0;
		let resizing = false;
		const finishResize = event => {
			if (!resizing) return;
			resizing = false;
			delete document.documentElement.dataset.studioResizing;
			if (event?.pointerId !== undefined && resizer.hasPointerCapture?.(event.pointerId)) {
				resizer.releasePointerCapture(event.pointerId);
			}
			setContextWidth(currentContextWidth, true);
		};
		resizer.addEventListener('pointerdown', event => {
			if (event.button !== 0 || !matchMedia('(min-width: 1101px)').matches || document.documentElement.dataset.studioContext === 'collapsed') return;
			resizing = true;
			pointerStartLeft = contextPanel.getBoundingClientRect().left;
			document.documentElement.dataset.studioResizing = 'true';
			resizer.setPointerCapture?.(event.pointerId);
			event.preventDefault();
		});
		resizer.addEventListener('pointermove', event => {
			if (!resizing) return;
			setContextWidth(event.clientX - pointerStartLeft);
			event.preventDefault();
		});
		resizer.addEventListener('pointerup', finishResize);
		resizer.addEventListener('pointercancel', finishResize);
		resizer.addEventListener('keydown', event => {
			if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
			const step = event.shiftKey ? 24 : 8;
			const nextWidth = event.key === 'Home'
				? contextWidth.minimum
				: event.key === 'End'
					? contextWidth.maximum
					: currentContextWidth + (event.key === 'ArrowLeft' ? -step : step);
			setContextWidth(nextWidth, true);
			event.preventDefault();
		});
	});
})();
