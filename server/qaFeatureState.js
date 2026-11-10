import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** Wait for the previously evidenced state, never relax its identity or replay
 * the control. A partially hydrated DOM is not a changed feature contract. */
export async function awaitFeatureInventory(expected, read, signal, intervalMs = 150) {
  for (let attempt = 0; attempt < 4; attempt++) {
    signal?.throwIfAborted();
    const inventory = await read();
    if (inventory?.stateKey === expected) return inventory;
    if (inventory?.legacyStateKey === expected) return { ...inventory, stateKey: expected };
    if (attempt < 3) await delay(intervalMs, undefined, { signal });
  }
  return null;
}

/** Stable UI structure, excluding field values, timestamps and arbitrary page
 * copy. A state key is identity for exploration, never correctness evidence. */
export function featureStateKey(inventory) {
  const url = new URL(inventory.url);
  const structure = {
    url: url.origin + url.pathname + url.hash,
    headings: inventory.headings || [], selected: inventory.selectedNavigation || [],
    controls: [...(inventory.navigationControls || []), ...(inventory.tabs || [])].map(({ label }) => label).sort(),
    panelControls: (inventory.controls || []).map(({ label, role, expanded, selected }) => [label, role, expanded, selected]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
    regions: inventory.regions || [],
    fields: inventory.fieldCount || 0, forms: (inventory.forms || []).map(({ fields }) => fields)
  };
  return createHash('sha256').update(JSON.stringify(structure)).digest('hex').slice(0, 24);
}

// Resume provenance for paths saved before panel controls were inventoried.
// This alias never substitutes for the richer identity of newly created paths.
export function legacyFeatureStateKey(inventory) {
  const url = new URL(inventory.url);
  return createHash('sha256').update(JSON.stringify({ url: url.origin + url.pathname + url.hash,
    headings: inventory.headings || [], selected: inventory.selectedNavigation || [],
    controls: [...(inventory.navigationControls || []), ...(inventory.tabs || [])].map(({ label }) => label).sort(),
    fields: inventory.fieldCount || 0, forms: (inventory.forms || []).map(({ fields }) => fields)
  })).digest('hex').slice(0, 24);
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
