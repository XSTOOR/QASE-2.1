/** Host-owned viewport identity. Temporary responsive samples are not devices. */
export function readQaViewport(page) {
  const value = page?.viewportSize?.();
  return value && Number.isFinite(value.width) && Number.isFinite(value.height) && value.width > 0 && value.height > 0 ? { width: value.width, height: value.height } : null;
}

export function checkPrimaryViewport(session, page) {
  if (!page || page.isClosed?.()) return;
  const current = readQaViewport(page);
  if (!session.hybrid.viewport?.primary) {
    if (current) session.hybrid.viewport = { primary: current, current, phase: 'selected_device', restored: true };
    return;
  }
  const primary = session.hybrid.viewport.primary;
  if (!current || current.width !== primary.width || current.height !== primary.height) return 'The browser did not restore the selected-device viewport. Execution paused to prevent checks in the wrong environment.';
}

export function responsiveWidths(original, boundaries = false) {
  return [...new Set(boundaries ? [original.width, 389, 390, 391, 767, 768, 769] : [390, 768, original.width])];
}
