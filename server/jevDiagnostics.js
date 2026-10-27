import { createHash } from 'node:crypto';

const bounded = (value, limit = 1500) => String(value ?? '').slice(0, limit);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
const sameOrigin = (a, b) => { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } };
const speculative = entry => entry.prefetch || entry.isPrefetch || entry.speculative || /\/__next\._tree\.txt(?:[?]|$)/.test(entry.url || entry.sourceId || '');

/** Preserve exact provenance and separate expected browser noise from defects.
 * Confidence scores cannot establish an HTTP or application failure by themselves.
 */
export function jevDiagnosticCandidates(snapshot, diagnostics, { includeExcluded = false } = {}) {
  const candidates = new Map();
  const blocked = new Set((diagnostics?.securityBlocks ?? []).map(item => item.url).filter(Boolean));
  const add = issue => {
    if (issue.excludedReason && !includeExcluded) return;
    const key = hash([issue.kind, issue.actual, issue.resourceUrl]);
    if (!candidates.has(key)) candidates.set(key, { ...issue, key, url: issue.url || snapshot?.url });
  };
  for (const entry of diagnostics?.console ?? []) {
    if ((entry.level ?? entry.type) !== 'error') continue;
    const message = bounded(entry.message || entry.text);
    const resourceUrl = entry.sourceId || entry.url;
    let excludedReason;
    if (/BROWSER_.*BLOCKED|ERR_BLOCKED_BY_CLIENT/i.test(message) || blocked.has(resourceUrl)) excludedReason = 'QASE/browser policy blocked the resource; this is not a target defect.';
    else if (/Failed to load resource/i.test(message)) excludedReason = 'Resource console message is reviewed using the corresponding network request, not counted twice.';
    else if (speculative(entry)) excludedReason = 'Speculative prefetch failure does not establish failure of the actual destination.';
    else if (resourceUrl && !sameOrigin(resourceUrl, snapshot?.url)) excludedReason = 'Third-party console output has no demonstrated first-party workflow failure.';
    const exception = entry.kind === 'pageerror' || /(?:Uncaught\s+(?:\(in promise\)\s+)?|^(?:Type|Reference|Syntax|Range)Error:)/.test(message);
    add({ title: exception ? 'Uncaught JavaScript error during the tested page' : 'Browser console error observed', kind: exception ? 'console_exception' : 'console_observation', eligibleForConfirmation: exception && !excludedReason,
      category: 'console', severity: 'medium', expected: 'The tested page executes without an uncaught JavaScript error.', actual: message,
      resourceUrl, url: entry.pageUrl, excludedReason, evidence: bounded(JSON.stringify(entry)), steps: [`Open ${entry.pageUrl || snapshot?.url}`, 'Observe the browser error, then reload and check whether the same exception recurs.'] });
  }
  for (const entry of diagnostics?.network ?? []) {
    const status = entry.statusCode ?? entry.status;
    if (!(status >= 400) && !(entry.error || entry.failure)) continue;
    let excludedReason;
    if (blocked.has(entry.url) || /ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(entry.error || entry.failure || '')) excludedReason = 'Policy-blocked or superseded browser request; not an established site defect.';
    else if (speculative(entry)) excludedReason = 'Speculative prefetch failure; actual destination navigation has not failed.';
    else if (!sameOrigin(entry.url, snapshot?.url)) excludedReason = 'Third-party request without a demonstrated failure of the tested workflow.';
    else if ([401, 403].includes(status)) excludedReason = 'Authentication/access denial alone is not a defect in an unauthenticated review.';
    const essential = ['document', 'script', 'stylesheet', 'image', 'font'].includes(entry.resourceType);
    const actual = `${status ?? entry.error ?? entry.failure} ${bounded(entry.url, 700)}`;
    add({ title: `Request ${status ? `returned HTTP ${status}` : 'failed'} while loading the page`, kind: entry.resourceType === 'document' ? 'http_document' : 'http_resource', category: 'network', severity: entry.resourceType === 'document' && status >= 500 ? 'high' : 'medium',
      eligibleForConfirmation: essential && !excludedReason && status !== 429 && (entry.method || 'GET') === 'GET', resourceUrl: entry.url, statusCode: status,
      excludedReason, url: entry.pageUrl, expected: 'The required page or asset loads successfully.', actual, evidence: bounded(JSON.stringify(entry)), steps: [`Open ${entry.pageUrl || snapshot?.url}`, `Observe ${entry.resourceType || 'request'} ${entry.url}`, 'Reload the page to independently confirm the same failure.'] });
  }
  if (snapshot?.success && !snapshot.loading && !snapshot.title?.trim()) add({ title: 'Page has no document title', kind: 'document_title', eligibleForConfirmation: true, category: 'accessibility', severity: 'low', expected: 'The document has a descriptive title.', actual: 'The browser snapshot returned an empty document title.', evidence: `Document title was empty at ${snapshot.url}.`, resourceUrl: snapshot.url, steps: [`Open ${snapshot.url}`, 'Read the document title after rendering, then reload to confirm.'] });
  return [...candidates.values()];
}
