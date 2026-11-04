/** Presence is discovery, never a passing assertion. Undefined means the
 * inventory cannot support either presence or absence for this category. */
export function observedCheckPresence(inventory, category) {
  if (!inventory || inventory.readiness?.ready === false) return undefined;
  if (category === 'search' && Array.isArray(inventory.search)) return inventory.search.length > 0;
  if (category === 'forms' && Number.isFinite(inventory.fieldCount) && Array.isArray(inventory.forms)) return inventory.fieldCount > 0 || inventory.forms.some(form => form.fields > 0);
  if (category === 'media' && Number.isFinite(inventory.images) && Number.isFinite(inventory.players)) return inventory.images > 0 || inventory.players > 0;
  return undefined;
}
