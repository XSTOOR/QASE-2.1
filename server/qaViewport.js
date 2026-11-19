/** Host-owned viewport identity. Temporary responsive samples are not devices. */
export function readQaViewport(page) {
  const value = page?.viewportSize?.();
  return value && Number.isFinite(value.width) && Number.isFinite(value.height) && value.width > 0 && value.height > 0 ? { width: value.width, height: value.height } : null;
}

export function responsiveWidths(original, boundaries = false) {
  return [...new Set(boundaries ? [original.width, 389, 390, 391, 767, 768, 769] : [390, 768, original.width])];
}
