// Fixed interaction oracles for explicitly declared UI contracts. Model text
// cannot supply scripts. Requests are blocked during local-only trials: a
// dependency becomes a coverage gap, never a manufactured application defect.
const risky = /delete|remove|logout|log.?out|sign.?out|reset|purchase|checkout|payment|subscribe|send|invite|publish|deploy|save|create|destroy|revoke|confirm|unsubscribe/i;
const result = (check, name, pass, expected, actual, second, kind) => ({
  check, name, outcome: pass ? 'pass' : 'fail', expected, actual: JSON.stringify(actual).slice(0, 1500),
  ...(!pass ? { reproduction: { confirmed: Boolean(second), observations: second ? 2 : 1, kind, first: actual, second } } : {})
});

export async function isolated(page, task) {
  const originalUrl = page.url();
  const blocked = [];
  const guard = route => {
    const request = route.request();
    // Lazy styles/images are normal rendering dependencies. Let the existing
    // context security policy decide them; never bypass it with continue().
    if (request.method() === 'GET' && ['image', 'font', 'stylesheet', 'script', 'media'].includes(request.resourceType())) return route.fallback();
    blocked.push({ method: request.method(), url: request.url() });
    return route.abort('blockedbyclient');
  };
  await page.route('**/*', guard);
  const restorePage = async () => {
    // A hash-link can replace the entire document's UI (e.g. an article
    // reader). Restore the known source with a normal policy-guarded load;
    // editing the address alone leaves stale selectors on the article view.
    await page.unroute('**/*', guard);
    try { await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }); }
    finally { await page.route('**/*', guard); }
  };
  try { return await task(blocked, restorePage); }
  finally { await page.unroute('**/*', guard); }
}

export async function runJevAnchors(page, { inspect, settle, prepare, authorizeControl, onAction }) {
  const inventory = await inspect(page);
  const source = new URL(page.url());
  const anchors = inventory.links.filter(link => {
    const target = new URL(link.href);
    return target.origin === source.origin && target.pathname === source.pathname && target.search === source.search && target.hash.length > 1 && !target.hash.startsWith('#:~:') && !target.hash.startsWith('#/') && !target.hash.startsWith('#!') && !link.download && (!link.target || link.target === '_self') && !risky.test(link.label);
  });
  const unique = [...new Map(anchors.map(link => [link.href, link])).values()];
  const assertions = [], trials = [];
  const original = await page.evaluate(() => ({ x: scrollX, y: scrollY, url: location.href }));
  const observe = href => page.evaluate(href => {
    let id;
    try { id = decodeURIComponent(new URL(href).hash.slice(1)); } catch { return { invalid: true }; }
    const node = document.getElementById(id) || [...document.getElementsByName(id)].find(element => element.tagName === 'A');
    return { href, id, exists: Boolean(node), text: document.body.innerText.slice(0, 12000) };
  }, href);
  try {
    await isolated(page, async (blocked, restorePage) => {
      for (const link of unique.slice(0, 16)) {
        try {
          await authorizeControl?.(link.selector);
          if (await page.locator(link.selector).evaluate(element => element.href, undefined, { timeout: 2000 }) !== link.href) { trials.push({ href: link.href, skipped: 'Observed link changed before execution.' }); continue; }
          await prepare(page, link.selector);
          const before = await observe(link.href);
          if (before.invalid) { trials.push({ href: link.href, skipped: 'Unparseable fragment.' }); continue; }
          const offset = blocked.length;
          await onAction?.({ phase: 'before', action: 'click', selector: link.selector });
          await page.locator(link.selector).click({ timeout: 2500 });
          await settle(page);
          await onAction?.({ phase: 'after', action: 'click', selector: link.selector });
          const first = await observe(link.href);
          // A custom fragment handler may legitimately open content without a
          // named target. Do not classify that as a broken native anchor.
          if (new URL(page.url()).pathname !== source.pathname || (!first.exists && (blocked.length > offset || before.text !== first.text))) {
            trials.push({ href: link.href, skipped: 'Custom handler or network dependency; native fragment oracle is insufficient.' });
            await restorePage();
            await settle(page);
            continue;
          }
          let second;
          if (!first.exists) { await page.locator(link.selector).click({ timeout: 2500 }); await settle(page); second = await observe(link.href); }
          if (blocked.length > offset || (second && (second.exists || second.text !== first.text))) { trials.push({ href: link.href, skipped: 'Initial missing target did not reproduce or depended on blocked requests.' }); continue; }
          const clean = value => value && ({ href: value.href, id: value.id, exists: value.exists });
          assertions.push(result('broken_links', 'In-page link resolves to an existing target', first.exists, 'A fragment target exists, or an observable custom interaction handles the link', clean(first), clean(second), 'missing-fragment'));
          trials.push({ href: link.href, executed: true });
        } catch (error) { trials.push({ href: link.href, skipped: `Could not exercise observed link: ${String(error.message).split('\nCall log:')[0].slice(0, 400)}` }); }
      }
    });
  } finally {
    // Restore scroll/address after native anchors; custom UI is reloaded above.
    if (new URL(page.url()).origin === source.origin && new URL(page.url()).pathname === source.pathname) await page.evaluate(original => { history.replaceState(history.state, '', original.url); scrollTo({ left: original.x, top: original.y, behavior: 'instant' }); }, original);
  }
  return { assertions, trials, omitted: Math.max(0, unique.length - 16), limitations: 'Same-document fragment targets only. Custom handlers, text fragments, hash routers and network-dependent interactions require separate scenarios.' };
}

export async function runJevTabs(page, { inspect, settle, prepare, authorizeControl, onAction }) {
  const inventory = await inspect(page);
  const tabs = inventory.tabs || [];
  const assertions = [], trials = [];
  const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  const describe = selector => page.locator(selector).evaluate(element => {
    const group = element.closest('[role="tablist"]');
    const selected = group ? [...group.querySelectorAll('[role="tab"][aria-selected="true"]')].length : null;
    const panelId = element.getAttribute('aria-controls');
    const panel = panelId && document.getElementById(panelId);
    const visible = node => {
      if (!node?.getClientRects().length || node.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
      for (let current = node; current; current = current.parentElement) { const s = getComputedStyle(current); if (s.visibility === 'hidden' || Number(s.opacity) === 0) return false; }
      return true;
    };
    return { label: (element.innerText || element.getAttribute('aria-label') || '').slice(0, 180), selected: element.getAttribute('aria-selected'), selectedCount: selected, panelId, panelExists: Boolean(panel), panelVisible: visible(panel) };
  }, undefined, { timeout: 2000 });
  await isolated(page, async blocked => {
    try {
      for (const tab of tabs.slice(0, 12)) {
        try {
          if (risky.test(tab.label)) { trials.push({ selector: tab.selector, skipped: 'Requires an authorized workflow.' }); continue; }
          await authorizeControl?.(tab.selector);
          const offset = blocked.length;
          await prepare(page, tab.selector);
          await onAction?.({ phase: 'before', action: 'click', selector: tab.selector });
          await page.locator(tab.selector).click({ timeout: 2500 }); await settle(page);
          await onAction?.({ phase: 'after', action: 'click', selector: tab.selector });
          const first = await describe(tab.selector);
          const valid = state => state.selected === 'true' && (state.selectedCount === null || state.selectedCount === 1) && (!state.panelId || state.panelVisible);
          let second;
          if (!valid(first)) { await page.locator(tab.selector).click({ timeout: 2500 }); await settle(page); second = await describe(tab.selector); }
          if (blocked.length > offset) { trials.push({ selector: tab.selector, skipped: 'Tab requires network access; local-only trial cannot establish correctness.' }); continue; }
          assertions.push(result('navigation', 'Tab activation selects one tab and reveals its declared panel', valid(first), 'Activated tab selected, no competing selection, and any aria-controls panel visible', first, second && !valid(second) ? second : undefined, 'tab-state'));
          trials.push({ selector: tab.selector, label: tab.label, executed: true, ...(first.panelId ? {} : { limitation: 'No explicit panel relationship; selected state only, content relevance unverified.' }) });
        } catch (error) { trials.push({ selector: tab.selector, label: tab.label, skipped: `Could not exercise observed tab: ${String(error.message).split('\nCall log:')[0].slice(0, 400)}` }); }
      }
    } finally {
      for (const tab of tabs.filter(tab => tab.selected === 'true')) {
        if (!risky.test(tab.label) && await page.locator(tab.selector).count() === 1) { await authorizeControl?.(tab.selector); await page.locator(tab.selector).click({ timeout: 2500 }); }
      }
      await settle(page);
      await page.evaluate(scroll => scrollTo({ left: scroll.x, top: scroll.y, behavior: 'instant' }), scroll);
    }
  });
  return { assertions, trials, omitted: Math.max(0, tabs.length - 12), limitations: 'Local tab selection and declared panel visibility; arbitrary content correctness and remote dependencies are not established.' };
}
