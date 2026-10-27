/** Routing callbacks outlive individual page actions during navigation/unroute.
 * A cancelled/already-consumed request must not become an unhandled rejection
 * that kills the API process. Unknown failures remain fail-closed. */
export function safeBrowserRoute(handler, onFailure = () => {}) {
  return async route => {
    try { return await handler(route); }
    catch (error) {
      const cancelled = /route is already handled|target (?:page, context or browser has been closed|closed)|page has been closed|browser has been closed|request (?:was )?(?:cancelled|canceled)|frame was detached/i.test(String(error?.message || ''));
      if (cancelled) return;
      try { await route.abort('blockedbyclient'); } catch { /* Request may already be cancelled; never continue it. */ }
      try { await onFailure({ code: 'BROWSER_ROUTE_DISPATCH_FAILED', message: 'A browser request could not be safely dispatched and was blocked.' }); } catch { /* Diagnostics cannot crash the routing callback. */ }
    }
  };
}
