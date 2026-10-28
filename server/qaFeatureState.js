import { createHash } from 'node:crypto';

/** Stable UI structure, excluding field values, timestamps and arbitrary page
 * copy. A state key is identity for exploration, never correctness evidence. */
export function featureStateKey(inventory) {
  const url = new URL(inventory.url);
  const structure = {
    url: url.origin + url.pathname + url.hash,
    headings: inventory.headings || [], selected: inventory.selectedNavigation || [],
    controls: [...(inventory.navigationControls || []), ...(inventory.tabs || [])].map(({ label }) => label).sort(),
    fields: inventory.fieldCount || 0, forms: (inventory.forms || []).map(({ fields }) => fields)
  };
  return createHash('sha256').update(JSON.stringify(structure)).digest('hex').slice(0, 24);
}

export function featureRouteFromTransition(route, result, authenticationContext) {
  const change = result?.transition;
  if (!change || change.from === change.to || !result.inventory || !result.hostEvidenceId ||
      new URL(result.inventory.url).href !== new URL(route.url).href || (route.featurePath?.length || 0) >= 4) return null;
  const featurePath = [...(route.featurePath || []), { ...change.control, from: change.from, to: change.to, evidenceId: result.hostEvidenceId }];
  const rootUrl = route.rootUrl || route.url;
  return { id: createHash('sha256').update(JSON.stringify([rootUrl, authenticationContext, change.to])).digest('hex').slice(0, 24),
    kind: 'feature', url: result.inventory.url, rootUrl, source: rootUrl, stateKey: change.to, featurePath,
    label: featurePath.map(step => step.label).join(' / '), authenticationContext,
    evidenceId: result.hostEvidenceId, status: 'pending' };
}
