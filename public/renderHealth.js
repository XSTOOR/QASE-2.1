/** Route-aware paint probe. A collapsed rail is intentionally only 64px wide. */
export function renderProbeIds(page) {
  return ({
    'new-run': ['qa-start'],
    'matrix-run': ['run-startup-page'],
    account: ['profile-dialog'],
    bugs: ['bugs-view'],
    results: ['results-page-head', 'workspace-viewer']
  })[page] ?? ['workspace-runs', 'workspace-agent'];
}

export function hasInteractiveSurface(node) {
  if (!node) return false;
  const visible = element => {
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return false;
    return typeof element.checkVisibility === 'function'
      ? element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      : element.offsetParent !== null;
  };
  return visible(node) && [...node.querySelectorAll('button, a, input, textarea, [tabindex]')].some(visible);
}
