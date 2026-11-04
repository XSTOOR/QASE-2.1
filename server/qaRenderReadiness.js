/** Control-local readiness for host-authored checks. A rotating hero, timer or
 * unrelated progress indicator must not delay every FAQ/accordion operation. */
export async function settleQaControl(page, selector, before) {
  if (before && (before.open !== undefined || ['true', 'false'].includes(before.expanded))) {
    await page.waitForFunction(({ selector, before }) => {
      const node = document.querySelector(selector);
      return !node || node.getAttribute('aria-expanded') !== before.expanded || node.closest('details')?.open !== before.open;
    }, { selector, before: { expanded: before.expanded, open: before.open } }, { timeout: 800 }).catch(error => { if (error.name !== 'TimeoutError') throw error; });
  }
  return page.evaluate(selector => new Promise(resolve => {
    const node = document.querySelector(selector);
    if (!node) return resolve({ ready: false, reason: 'Control detached' });
    const panels = (node.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)).filter(Boolean);
    const roots = [node.closest('details') || node, ...panels];
    let quiet, done = false;
    const finish = reason => { if (done) return; done = true; observer.disconnect(); clearTimeout(quiet); clearTimeout(deadline); resolve({ ready: reason === 'stable', reason }); };
    const stable = () => {
      const busy = roots.some(root => root.matches('[aria-busy="true"]') || root.querySelector('[aria-busy="true"]'));
      const moving = roots.some(root => root.getAnimations({ subtree: true }).some(a => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity));
      if (!busy && !moving) finish('stable'); else quiet = setTimeout(stable, 40);
    };
    const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(stable, 80); });
    for (const root of roots) observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'style', 'open', 'aria-expanded', 'aria-busy'] });
    const deadline = setTimeout(() => finish('Control did not settle within the bounded readiness window'), 800);
    requestAnimationFrame(() => requestAnimationFrame(() => { quiet = setTimeout(stable, 80); }));
  }), selector);
}
