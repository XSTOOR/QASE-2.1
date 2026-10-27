/** One host definition of route capacity and depth. Attempts consume slots
 * even when navigation fails; they never imply successful test coverage. */
export const HYBRID_ROUTE_CHECKS = Object.freeze(['navigation', 'responsive', 'forms', 'search', 'media', 'accessibility', 'console_health', 'broken_links']);
import { hasConfirmedAccess } from './hybridAuth.js';

export function hybridRoutePolicy(state) {
  const exploration = state?.exploration;
  const allRoutes = exploration?.routes || [];
  const access = hasConfirmedAccess(state) ? state.authentication.grantId : 'public';
  const routes = allRoutes.filter(route => (route.authenticationContext || 'public') === access);
  const limit = exploration?.maxPages || 0;
  const attempted = routes.filter(route => ['running', 'tested', 'failed', 'interrupted'].includes(route.status)).length;
  const tested = routes.filter(route => route.status === 'tested').length;
  const pending = routes.filter(route => route.status === 'pending').length;
  const totalAttempted = allRoutes.filter(route => ['running', 'tested', 'failed', 'interrupted'].includes(route.status)).length;
  const remainingSlots = Math.max(0, limit - totalAttempted);
  const target = Math.min(attempted + remainingSlots, routes.length);
  const closeout = Boolean(state?.budgetFinalizing);
  const executableScope = !Array.isArray(state?.scope) || state.scope.some(category => HYBRID_ROUTE_CHECKS.includes(category));
  const canExplore = executableScope && !closeout && remainingSlots > 0 && pending > 0;
  return { observed: routes.length, attempted, totalAttempted, tested, pending, limit, target, remainingSlots,
    nextBatchSize: canExplore ? Math.min(3, remainingSlots, pending) : 0,
    canExplore, depthPending: attempted < target,
    publicationAllowed: closeout || !executableScope || attempted >= target,
    stopReason: closeout ? 'budget_closeout' : !executableScope ? 'unsupported_scope' : remainingSlots === 0 && limit > 0 ? 'page_limit' : pending === 0 ? 'frontier_exhausted' : null };
}
