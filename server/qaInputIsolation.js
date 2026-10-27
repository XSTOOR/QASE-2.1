/** Host-owned per-document egress quarantine. Remains active after input tests
 * so delayed autosaves cannot escape when the immediate test has finished.
 * Only a real document response during an approved navigation releases it. */
export function createQaInputIsolation() {
  const states = new Map(), contexts = new WeakSet();
  const blocked = []; blocked.total = 0;
  const key = value => { const url = new URL(value); url.hash = ''; return url.href; };
  const active = context => [...states].some(([page, state]) => state.active && page.context() === context && !page.isClosed());
  function watch(page, guarded = false) {
    if (states.has(page)) { if (guarded) states.get(page).active = true; return states.get(page); }
    const state = { active: guarded, allowed: new Set(), blocked: [] }; states.set(page, state);
    page.on?.('close', () => states.delete(page));
    page.on?.('response', response => {
      const request = response.request();
      if (state.active && request.isNavigationRequest() && response.frame() === page.mainFrame() && state.allowed.has(key(request.url()))) state.fresh = key(request.url());
    });
    page.on?.('framenavigated', frame => {
      if (state.active && frame === page.mainFrame() && state.fresh && key(frame.url()) === state.fresh) { state.active = false; state.fresh = undefined; }
    });
    return state;
  }
  return {
    attach(context) {
      if (contexts.has(context)) return; contexts.add(context);
      context.on?.('page', page => watch(page, active(context)));
      for (const page of context.pages?.() || []) watch(page);
    },
    protect(page) { for (const owned of page.context().pages()) watch(owned, true); watch(page, true); return blocked; },
    decision(request) {
      let page;
      try { page = request.frame().page(); } catch { /* Worker/frameless requests fail closed while any document is quarantined. */ }
      const state = page && watch(page, active(page.context()) && !states.has(page));
      if (!state?.active && (page || ![...states.values()].some(item => item.active))) return;
      if (state && request.method() === 'GET' && request.isNavigationRequest() && request.frame() === page.mainFrame() && state.allowed.has(key(request.url()))) return;
      let url; try { const value = new URL(request.url()); url = `${value.origin}${value.pathname}`; } catch { url = 'Unparseable destination'; }
      // No query strings, request bodies or field values in quarantine records.
      blocked.total++;
      if (blocked.length < 100) blocked.push({ method: request.method(), resourceType: request.resourceType(), url });
      return { allowed: false, code: 'QA_INPUT_EGRESS_BLOCKED', message: 'Input testing blocks network side effects, including delayed autosaves. A fresh approved document navigation is required to leave quarantine.' };
    },
    async navigation(page, urls, work) {
      const state = page && states.get(page);
      if (!state?.active) return work();
      const old = state.allowed; state.allowed = new Set(urls.filter(Boolean).map(key));
      try { return await work(); } finally { state.allowed = old; state.fresh = undefined; }
    }
  };
}
