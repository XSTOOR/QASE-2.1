export const FOUNDER_CONTEXT_FIELDS = Object.freeze([
  { key: 'stage', label: 'product stage' },
  { key: 'businessModel', label: 'business model' },
  { key: 'targetCustomer', label: 'target customer' },
  { key: 'primaryGoal', label: 'primary goal' }
]);

/** One readiness contract for the launcher and the versioned HTTP setup. */
export function founderLaunchProblems(input = {}) {
  const missing = [];
  if (input.catalogReady === false) missing.push('load the review catalog');
  try {
    const url = new URL(String(input.targetUrl ?? '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    if (input.accessDecision === 'authenticated' && url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) missing.push('use HTTPS for signed-in review');
  } catch { missing.push('enter a complete HTTP or HTTPS target URL without embedded credentials'); }
  if (input.authorizationConfirmed !== true) missing.push('confirm permission to review this product');
  if (!String(input.environmentId ?? '').trim()) missing.push('choose a device and browser in REVIEW ON');
  if (!['public_only', 'authenticated'].includes(input.accessDecision)) missing.push('choose which pages to review');
  if (input.accessDecision === 'authenticated' && input.authenticatedAvailable === false) missing.push('choose public pages only; sign-in review is unavailable in the current execution mode');
  if (!['provided', 'assumptions'].includes(input.contextMode)) missing.push('choose how to supply business context');
  if (input.contextMode === 'provided') {
    for (const { key, label } of FOUNDER_CONTEXT_FIELDS) {
      if (!String(input.productContext?.[key] ?? '').trim()) missing.push(`enter the ${label}`);
    }
  }
  return missing;
}
