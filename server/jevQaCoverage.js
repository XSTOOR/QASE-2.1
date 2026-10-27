/** Coverage is derived from executed observations, not the model's confidence.
 * A sampled route is useful evidence, but is not a complete navigation test.
 */
export function jevQaCoverage(selected, observations, { browserError, failedActions = [] } = {}) {
  const pages = observations.filter(({ page }) => page && !page.loading && !page.loadError && page.bodyText?.trim());
  const covered = [...new Set(pages.map(({ page }) => `Observed ${page.url} — ${page.title || '(untitled)'}`))];
  const outcomes = selected.map(id => {
    let status = 'not_tested';
    let detail;
    const diagnosticsComplete = pages.length > 0 && pages.every(({ diagnostics }) => diagnostics?.success !== false && Array.isArray(diagnostics?.console) && Array.isArray(diagnostics?.network));
    switch (id) {
      case 'console_health':
        if (diagnosticsComplete) {
          status = 'tested';
          detail = `Captured console and network diagnostics for all ${pages.length} rendered page observations; this does not cover unsampled workflows.`;
        } else detail = 'Console/network diagnostics were unavailable for one or more page observations.';
        break;
      case 'navigation':
        if (pages.length) {
          status = 'partial';
          detail = `Rendered ${new Set(pages.map(({ page }) => page.url)).size} distinct observed routes. Link-click behavior, browser back-state and unsampled destinations remain unverified.`;
        } else detail = 'No rendered route was observed.';
        break;
      case 'broken_links':
        if (diagnosticsComplete) {
          status = 'partial';
          detail = 'Inspected HTTP failures recorded while loading sampled pages; did not crawl every link or external destination.';
        } else detail = 'Complete request diagnostics were unavailable; link targets were not exhaustively checked.';
        break;
      case 'forms': {
        const audits = pages.map(({ diagnostics }) => diagnostics?.formValidation).filter(audit => Number.isFinite(audit?.fieldCount));
        const fields = audits.reduce((total, audit) => total + audit.fieldCount, 0);
        if (fields > 0) {
          status = 'partial';
          detail = `Read-only native validation inspection recorded ${fields} fields across page observations. No values were generated and no forms were submitted; positive/negative submission behavior is untested.`;
        } else detail = 'No form fields were recorded in the bounded sample. Form submission behavior is untested; absence in this sample does not prove site-wide absence.';
        break;
      }
      case 'authentication':
        detail = 'Login, logout and protected-route workflows were not executed. Supply an authorized test account and explicit authentication scenario for further testing.';
        break;
      case 'search':
        detail = 'Search queries and expected-result assertions were not executed. Supply a query and expected result; the Decisions API does not generate arbitrary text inputs.';
        break;
      case 'responsive':
        if (pages.some(({ page }) => page.viewport?.width && page.viewport?.height)) {
          status = 'partial';
          detail = 'Captured the selected runtime viewport. No multi-viewport comparison, orientation change or visual layout assertion was executed.';
        } else detail = 'No multi-viewport or visual layout assertions were executed.';
        break;
      case 'media':
        detail = 'Playback, pause, audio and seek assertions were not executed; media behavior is untested.';
        break;
      default:
        detail = id.startsWith('security_')
          ? 'The complete authorized security scenario and positive/negative evidence were not executed.'
          : 'No executable evidence contract is available for this selected check.';
    }
    if (status !== 'not_tested') covered.push(`${id} (${status}): ${detail}`);
    return { id, status, detail };
  });
  const notCovered = outcomes.filter(item => item.status !== 'tested').map(item => `${item.id} (${item.status}): ${item.detail}`);
  for (const action of failedActions) notCovered.push(`Browser action failed: ${action.label} — ${action.error}`);
  if (!pages.length) notCovered.unshift(`Browser unavailable: ${browserError || 'No successfully rendered page snapshot was captured.'}`);
  const useful = outcomes.some(item => item.status !== 'not_tested');
  return { covered, notCovered, outcomes, blocked: !pages.length || !useful, incomplete: notCovered.length > 0 };
}
