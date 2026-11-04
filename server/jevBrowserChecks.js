/** Fixed, bounded browser scenarios. No model-written scripts or selectors.
 * All actions use the already policy-guarded browser context. No form is
 * submitted and no credentials, purchases or persistent records are created.
 */
import { runJevAccessibility } from './jevAccessibility.js';
import { runJevAnchors, runJevTabs, isolated } from './jevInteractions.js';
import { responsiveWidths } from './qaViewport.js';
import { settleQaControl } from './qaRenderReadiness.js';
import { runLiveFormChecks } from './qaLiveForms.js';

export const JEV_BROWSER_CHECKS = ['inspect', 'navigation', 'responsive', 'forms', 'search', 'media', 'disclosure', 'accessibility', 'dismiss_overlay', 'anchors', 'tabs', 'scroll'];
const risky = /delete|remove|logout|log.?out|sign.?out|reset|cancel|purchase|checkout|payment|subscribe|send|invite|publish|deploy|save|create|destroy|revoke|confirm|unsubscribe/i;
const trim = value => String(value ?? '').slice(0, 1500);
const sameUrl = (a, b) => new URL(a).href.replace(/\/$/, '') === new URL(b).href.replace(/\/$/, '');
const assertion = (check, name, passed, expected, actual) => ({ check, name, outcome: passed ? 'pass' : 'fail', expected, actual: trim(typeof actual === 'string' ? actual : JSON.stringify(actual)) });

export async function settleJevPage(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 8000 });
  await page.waitForFunction(() => document.body && document.readyState !== 'loading', undefined, { timeout: 8000 });
  // Wait for rendering to settle, not for an arbitrary minimum run duration.
  await page.evaluate(() => new Promise(resolve => {
    let timer;
    const finish = () => { observer.disconnect(); clearTimeout(timer); clearTimeout(deadline); resolve(); };
    const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(finish, 180); });
    const deadline = setTimeout(finish, 1200);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    timer = setTimeout(finish, 180);
  }));
  // A quiet loading shell is not a rendered application. Wait for explicit
  // busy state to clear; callers still record the observation if it times out.
  await page.waitForFunction(() => {
    const text = document.body?.innerText.trim() || '';
    const loadingShell = /^(loading|please wait|loading[.\s…]+|loading (page|application|app)[.\s…]*)$/i.test(text);
    const busy = [...document.querySelectorAll('[aria-busy="true"]')].some(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
    // A download/meter/demo progressbar on an otherwise rendered page is not
    // a loading shell and cannot impose a repeated three-second wait.
    return !busy && !loadingShell;
  }, undefined, { timeout: 3000 }).catch(() => {});
}

export async function inspectJevPage(page) {
  await settleJevPage(page);
  await page.waitForFunction(() => document.body?.innerText.trim().length > 0, undefined, { timeout: 5000 }).catch(() => {});
  const inventory = await page.evaluate(() => {
    const visible = element => {
      if (!element.getClientRects().length || element.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
      // Closed native details can expose descendant geometry while their
      // content is not interactable. Do not publish those links as visible.
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS' && !parent.open && !parent.querySelector(':scope > summary')?.contains(element)) return false;
      }
      for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    const selector = element => {
      if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) return `#${CSS.escape(element.id)}`;
      const steps = [];
      for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
        const tag = node.tagName.toLowerCase();
        const siblings = [...(node.parentElement?.children ?? [])].filter(item => item.tagName === node.tagName);
        steps.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
      }
      return steps.join(' > ');
    };
    const label = element => (element.getAttribute('aria-label') || element.innerText || element.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    const links = [...document.querySelectorAll('a[href]')].filter(visible).map(element => ({ selector: selector(element), href: element.href, label: label(element), target: element.target, download: element.hasAttribute('download') }));
    const forms = [...document.forms].map(form => ({ method: form.method, action: form.action, fields: form.querySelectorAll('input,select,textarea').length }));
    const search = [...document.querySelectorAll('input[type="search"],input[name="q"],input[name="query"],input[placeholder*="search" i],input[aria-label*="search" i],[role="searchbox"]')].filter(visible).filter(element => element.tagName === 'INPUT' && ['text', 'search'].includes(element.type)).map(element => ({ selector: selector(element), name: element.name, formMethod: element.form?.method, formAction: element.form?.action }));
    const auth = [...document.querySelectorAll('input[type="password"]')].filter(visible).length > 0 || links.some(link => /\b(log ?in|sign ?in|sign ?up)\b/i.test(link.label));
    const disclosures = [...document.querySelectorAll('summary,button,[role="button"]')].filter(visible).filter(element => element.getAttribute('role') !== 'tab' && !element.disabled && !element.form && element.getAttribute('aria-disabled') !== 'true').filter(element => /^(open |close |toggle |show |hide )?(menu|navigation|details|more|faq|help|filters?|accordion)\b/i.test(label(element)) || element.tagName === 'SUMMARY' || (element.hasAttribute('aria-controls') && element.hasAttribute('aria-expanded')) || (element.closest('[class*="faq" i],[class*="accordion" i]') && /\?/.test(label(element)))).map(element => ({ selector: selector(element), label: label(element) }));
    const tabs = [...document.querySelectorAll('button[role="tab"],[role="tablist"] [role="tab"]')].filter(visible).filter(element => !element.form && !element.hasAttribute('href') && !element.disabled && element.getAttribute('aria-disabled') !== 'true').map(element => ({ selector: selector(element), label: label(element), selected: element.getAttribute('aria-selected') }));
    const overlays = [...document.querySelectorAll('[role="dialog"],dialog[open],[aria-modal="true"]')].filter(visible).map(dialog => {
      const close = [...dialog.querySelectorAll('button,[role="button"]')].find(element => visible(element) && !element.disabled && !element.form && /^(close|dismiss)(?:\b|$)/i.test(label(element)));
      return { selector: selector(dialog), title: label(dialog).slice(0, 120), close: close ? { selector: selector(close), label: label(close) } : null };
    });
    return { url: location.href, title: document.title, text: document.body.innerText.slice(0, 6000), viewport: { width: innerWidth, height: innerHeight }, links: links.slice(0, 100), totalLinks: links.length, forms, fieldCount: [...document.querySelectorAll('input:not([type="hidden"]),select,textarea')].filter(visible).length, search, auth, authForm: [...document.querySelectorAll('input[type="password"]')].some(visible), disclosures: disclosures.slice(0, 24), totalDisclosures: disclosures.length, tabs: tabs.slice(0, 24), overlays, images: document.images.length, players: document.querySelectorAll('audio,video').length };
  });
  return inventory;
}

async function exploreScroll(page, signal) {
  const original = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  const samples = [];
  let remainingScroll = 0;
  try {
    for (let index = 0; index < 24; index++) {
      signal?.throwIfAborted();
      const sample = await page.evaluate(index => {
        // Overlap viewport samples; scrolling is required to trigger lazy
        // images and intersection-observer content, not just DOM retrieval.
        const y = Math.min(index * Math.max(200, innerHeight * 0.8), Math.max(0, document.documentElement.scrollHeight - innerHeight));
        scrollTo({ top: y, behavior: 'instant' });
        return { y, height: document.documentElement.scrollHeight, viewport: innerHeight };
      }, index);
      await settleJevPage(page);
      await page.evaluate(() => Promise.race([
        Promise.all(document.getAnimations().filter(animation => {
          const target = animation.effect?.target, box = target?.getBoundingClientRect?.();
          return animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity && box && box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
        }).map(animation => animation.finished.catch(() => {}))),
        new Promise(resolve => setTimeout(resolve, 800))
      ]));
      samples.push(sample);
      remainingScroll = await page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - innerHeight - scrollY));
      if (remainingScroll < 2) break;
    }
  } finally { await page.evaluate(position => scrollTo({ left: position.x, top: position.y, behavior: 'instant' }), original); await settleJevPage(page); }
  return { assertions: [], samples, remainingScroll, inventory: await inspectJevPage(page), limitations: 'Bounded document scrolling reveals lazy content. Infinite lists, nested scrollers and content beyond the scroll budget remain outside this sample.' };
}

async function prepareJevControl(page, selector) {
  // Browser smooth-scroll restoration can fight Playwright's actionability
  // scrolling, leaving a valid control moving/outside the viewport. Position
  // it deterministically, then retain the normal (never forced) click checks.
  await page.locator(selector).evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }), undefined, { timeout: 2000 });
  await settleQaControl(page, selector);
}

async function navigation(page, input, onAction) {
  const source = page.url();
  const node = page.locator(input.selector);
  if (await node.count() !== 1) throw new Error('Observed navigation selector is not unique.');
  const link = await node.evaluate(element => ({ href: element.href, text: element.innerText, target: element.target, download: element.hasAttribute('download'), tag: element.tagName }));
  const destination = new URL(link.href);
  if (link.tag !== 'A' || destination.origin !== new URL(source).origin || !['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password || destination.search || link.download || (link.target && link.target !== '_self') || risky.test(`${link.text} ${link.href}`) || !sameUrl(link.href, input.expected)) throw new Error('Navigation must use the exact observed safe same-origin anchor.');
  const assertions = [];
  let responseStatus, landed, title, phase = 'anchor click';
  const responseListener = response => { if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) responseStatus = response.status(); };
  page.on('response', responseListener);
  try {
    await prepareJevControl(page, input.selector);
    await onAction?.({ phase: 'before', action: 'click', selector: input.selector });
    await node.click({ timeout: 5000 });
    await page.waitForURL(url => !sameUrl(url.href, source), { timeout: 7000, waitUntil: 'domcontentloaded' });
    await settleJevPage(page);
    await onAction?.({ phase: 'after', action: 'click', selector: input.selector });
    landed = page.url();
    title = await page.title();
    await page.waitForFunction(() => document.body?.innerText.trim().length > 0, undefined, { timeout: 5000 }).catch(() => {});
    const rendered = await page.locator('body').innerText({ timeout: 3000 });
    assertions.push(assertion('navigation', 'Observed anchor reaches its destination', sameUrl(landed, destination.href), destination.href, landed));
    assertions.push(assertion('broken_links', 'Destination renders usable page content', rendered.trim().length > 0 && !(responseStatus >= 400), 'A non-empty page without an HTTP error', { url: landed, title, responseStatus, textLength: rendered.trim().length }));
    if (responseStatus >= 400) {
      phase = 'HTTP error reproduction';
      const second = await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 });
      assertions.push(assertion('broken_links', 'HTTP error reproduced on second load', !(second?.status() >= 400), 'A successful second load', { first: responseStatus, second: second?.status() }));
      if (second?.status() >= 400) assertions.find(item => item.check === 'broken_links' && item.outcome === 'fail').reproduction = { confirmed: true, observations: 2, kind: 'http-error', first: responseStatus, second: second.status() };
    }
    phase = 'browser back';
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
    await settleJevPage(page);
    assertions.push(assertion('navigation', 'Browser back restores source route', sameUrl(page.url(), source), source, page.url()));
    phase = 'browser forward';
    await page.goForward({ waitUntil: 'domcontentloaded', timeout: 10000 });
    await settleJevPage(page);
    assertions.push(assertion('navigation', 'Browser forward restores destination', sameUrl(page.url(), landed), landed, page.url()));
    return { assertions, source, destination: landed, title, responseStatus };
  } catch (error) {
    // A failed history/reproduction subcheck cannot erase the click/HTTP facts
    // already observed. It is not automatically retried or labeled a defect.
    if (!assertions.length) throw error;
    return { assertions, source, destination: landed, title, responseStatus,
      executionComplete: false, destinationReady: Boolean(landed && sameUrl(page.url(), landed)),
      gaps: [`${phase} was not completed: ${trim(error.message?.split('\n')[0])}. No automatic replay or history pass was inferred.`] };
  } finally { page.off('response', responseListener); }
}

async function responsive(page, options = {}) {
  const original = page.viewportSize();
  if (!original) return { assertions: [], skipped: 'This runtime does not expose a resizable viewport.' };
  const assertions = [];
  const measurements = [];
  const interactions = [];
  const position = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  const focus = options.responsiveBoundaries && page.evaluateHandle ? await page.evaluateHandle(() => document.activeElement) : null;
  try {
    for (const width of responsiveWidths(original, options.responsiveBoundaries)) {
      options.signal?.throwIfAborted();
      await page.setViewportSize({ width, height: original.height });
      await options.onViewport?.({ phase: 'responsive_sample', primary: original, current: page.viewportSize(), restored: false });
      options.signal?.throwIfAborted();
      await settleJevPage(page);
      const measure = () => page.evaluate(() => {
        const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
        const clipped = [...document.querySelectorAll('a,button,input,select,textarea')].filter(visible).filter(element => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          // Ignore intentionally off-canvas controls and horizontal carousels.
          let scrollContainer = element.parentElement;
          while (scrollContainer && scrollContainer !== document.body) {
            if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(scrollContainer).overflowX)) return false;
            scrollContainer = scrollContainer.parentElement;
          }
          return box.top >= 0 && box.top < innerHeight && box.width > 0 && style.position !== 'fixed' && (box.left < -2 || box.right > innerWidth + 2);
        }).slice(0, 10).map(element => ({ label: (element.innerText || element.getAttribute('aria-label') || element.tagName).slice(0, 100), left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }));
        return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, clipped };
      });
      const measured = await measure();
      const overflow = measured.documentWidth > measured.width + 2;
      const unreachable = measured.clipped.length > 0;
      let repeated;
      if (overflow || unreachable) { await settleJevPage(page); repeated = await measure(); }
      measurements.push({ ...measured, repeated });
      assertions.push({ ...assertion('responsive', `No horizontal document overflow at ${width}px`, !overflow, `Document width <= ${measured.width + 2}px`, measured), ...(overflow ? { reproduction: { confirmed: repeated.documentWidth > repeated.width + 2, observations: 2, kind: 'document-overflow', first: measured, second: repeated } } : {}) });
      assertions.push({ ...assertion('responsive', `Visible controls stay reachable at ${width}px`, !unreachable, 'Visible interactive controls fit the viewport or an intentional scroll container', measured.clipped), ...(unreachable ? { reproduction: { confirmed: measured.clipped.some(first => repeated.clipped.some(second => first.label === second.label && Math.abs(first.left - second.left) < 2 && Math.abs(first.right - second.right) < 2)), observations: 2, kind: 'clipped-control', first: measured.clipped, second: repeated.clipped } } : {}) });
      if (width === 390) {
        const inventory = await inspectJevPage(page);
        for (const menu of inventory.disclosures.filter(item => /\b(menu|navigation)\b/i.test(item.label)).slice(0, 2)) {
          try {
            await options.authorizeControl?.(menu.selector);
            const tested = await disclosure(page, { selector: menu.selector, restore: true }, options.onAction);
            interactions.push({ width, selector: menu.selector, success: !tested.blockedRequests?.length && !tested.gaps?.length, ...((tested.blockedRequests?.length || tested.gaps?.length) ? { error: tested.gaps?.join(' ') || tested.limitations } : {}) });
            assertions.push(...tested.assertions.map(item => ({ ...item, check: 'responsive', name: `${item.name} at ${width}px`, actual: trim(JSON.stringify({ width, evidence: item.actual })) })));
          } catch (error) { interactions.push({ width, selector: menu.selector, success: false, error: trim(error.message?.split('\n')[0]) }); }
        }
      }
    }
  } finally {
    try {
      await page.setViewportSize(original);
      if (focus) await focus.evaluate(element => { if (element?.isConnected && typeof element.focus === 'function') element.focus({ preventScroll: true }); });
      if (position) await page.evaluate(point => scrollTo({ left: point.x, top: point.y, behavior: 'instant' }), position);
      await settleJevPage(page);
      const restored = page.viewportSize();
      if (restored?.width !== original.width || restored?.height !== original.height) throw new Error('Selected-device viewport restoration failed.');
      await options.onViewport?.({ phase: 'selected_device', primary: original, current: restored, restored: true });
    } catch (error) {
      await options.onViewport?.({ phase: 'restore_failed', primary: original, current: page.viewportSize(), restored: false });
      throw error;
    } finally { await focus?.dispose(); }
  }
  return { assertions, measurements, interactions, ...(interactions.some(item => !item.success) ? { gaps: interactions.filter(item => !item.success).map(item => `Responsive control ${item.selector} at ${item.width}px: ${item.error}`) } : {}), restoredViewport: page.viewportSize(), limitations: 'DOM geometry and observed mobile navigation controls, not subjective visual review; no claim about every viewport or unexercised control.' };
}

async function forms(page) {
  // Work on detached copies: constraints are real DOM validity rules, while
  // app handlers, autosave and submission cannot create target-side records.
  const result = await page.evaluate(() => {
    const fields = [...document.querySelectorAll('input,textarea,select')].filter(element => element.getClientRects().length && element.willValidate && !['password', 'hidden', 'file', 'submit', 'button'].includes(element.type)).slice(0, 30);
    return fields.map(element => {
      const clone = element.cloneNode(true);
      const trials = [];
      const inspect = (name, value, expected) => { clone.value = value; trials.push({ name, expected, valid: clone.validity.valid, reason: ['valueMissing', 'typeMismatch', 'patternMismatch', 'tooLong', 'tooShort', 'rangeUnderflow', 'rangeOverflow', 'stepMismatch'].filter(key => clone.validity[key]) }); };
      if (clone.required) inspect('Required field rejects empty input', '', false);
      if (clone.type === 'email') { inspect('Email rejects malformed input', 'qase-invalid-email', false); if (!clone.pattern) inspect('Email accepts syntactically valid input', 'qase@example.invalid', true); }
      if (clone.type === 'url') { inspect('URL rejects malformed input', 'not a url', false); if (!clone.pattern) inspect('URL accepts syntactically valid input', 'https://example.invalid/', true); }
      if (clone.type === 'number') {
        if (clone.min !== '') inspect('Numeric lower boundary rejects below-minimum value', String(Number(clone.min) - 1), false);
        if (clone.max !== '') inspect('Numeric upper boundary rejects above-maximum value', String(Number(clone.max) + 1), false);
      }
      return { field: element.name || element.id || element.type, type: element.type, required: element.required, trials };
    });
  });
  return { fields: result, assertions: result.flatMap(field => field.trials.map(trial => assertion('forms', `${field.field}: ${trial.name}`, trial.valid === trial.expected, `Native validity ${trial.expected}`, trial))), limitations: 'Native constraint cases on detached DOM copies only. Application error messages, real submissions, preserved state and recovery require an authorized submission scenario.' };
}

async function search(page) {
  const inventory = await inspectJevPage(page);
  if (!inventory.search.length) return { assertions: [], absent: true, skipped: 'No visible search control on this sampled page.' };
  const assertions = [];
  const trials = [];
  const blockedRequests = [];
  for (const field of inventory.search.slice(0, 3)) {
    const node = page.locator(field.selector);
    const editable = await node.isEnabled() && await node.isEditable();
    assertions.push(assertion('search', 'Observed search control is enabled and editable', editable, 'An enabled editable search input', { selector: field.selector, method: field.formMethod }));
    if (!editable) continue;
    const contract = await node.evaluate(element => {
      const explicit = element.getAttribute('aria-controls');
      const scope = element.closest('section,[role="search"]');
      const candidates = explicit ? explicit.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean) : [...(scope?.querySelectorAll('[role="list"],[role="listbox"],ul,ol,[data-search-results]') ?? [])];
      const results = candidates.length === 1 ? candidates[0] : undefined;
      if (element.form || !results || !results.id || !results.querySelector('li,[role="option"],[role="listitem"],article')) return null;
      return { resultsId: results.id, value: element.value, explicit: Boolean(explicit) };
    });
    if (!contract) { trials.push({ selector: field.selector, skipped: 'No unambiguous standalone local result list; query submission remains untested.' }); continue; }
    const readResults = () => page.evaluate(id => {
      const results = document.getElementById(id);
      if (!results) return null;
      const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && !element.closest('[hidden],[aria-hidden="true"]');
      return { text: results.innerText.slice(0, 8000), items: [...results.querySelectorAll('li,[role="option"],[role="listitem"],article')].filter(visible).map(element => element.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 80) };
    }, contract.resultsId);
    // Run local filter trials only, under a request guard. A remote dependency
    // makes the trial inconclusive, never a target defect or an implicit pass.
    const guard = route => { blockedRequests.push({ url: route.request().url(), method: route.request().method() }); return route.abort('blockedbyclient'); };
    const requestStart = blockedRequests.length;
    await page.route('**/*', guard);
    try {
      await node.fill(''); await settleJevPage(page);
      const baseline = await readResults();
      const words = [...new Set((baseline?.items ?? []).flatMap(text => text.match(/[\p{L}\p{N}]{4,24}/gu) ?? []))];
      const query = words.find(word => { const count = baseline.items.filter(text => text.toLowerCase().includes(word.toLowerCase())).length; return count > 0 && count < baseline.items.length; });
      if (!query) { trials.push({ selector: field.selector, skipped: 'Result list lacks a discriminating observed term for a reliable search expectation.' }); continue; }
      await node.fill(query);
      await page.waitForFunction(({ id, text }) => document.getElementById(id)?.innerText !== text, { id: contract.resultsId, text: baseline.text }, { timeout: 1200 }).catch(() => {});
      await settleJevPage(page);
      const positive = await readResults();
      const responded = positive && baseline.text !== positive.text;
      if (!responded || blockedRequests.length > requestStart) { trials.push({ selector: field.selector, query, baseline, positive, skipped: blockedRequests.length > requestStart ? 'Search initiated a blocked network dependency; remote search was not exercised.' : 'No local filtering response observed; submit-driven search is outside this scenario.' }); continue; }
      assertions.push(assertion('search', 'Local search retains an observed matching result', positive.items.some(text => text.toLowerCase().includes(query.toLowerCase())), `A visible result containing the observed term ${query}`, { query, items: positive.items }));
      const miss = 'qaseunmatchedquery93871';
      await node.fill(miss); await settleJevPage(page);
      const negative = await readResults();
      await node.fill(query); await settleJevPage(page);
      await node.fill(miss); await settleJevPage(page);
      const repeated = await readResults();
      if (blockedRequests.length === requestStart && negative && repeated) {
        const filtered = !negative.items.some(text => baseline.items.includes(text));
        assertions.push({ ...assertion('search', 'Local search removes unmatched results', filtered, 'No original result item remains for an unmatched query', { query: miss, items: negative.items }), ...(!filtered ? { reproduction: { confirmed: negative.items.length > 0 && JSON.stringify(negative.items) === JSON.stringify(repeated.items) && negative.items.some(text => baseline.items.includes(text)), observations: 2, kind: 'local-search-filter', first: negative, second: repeated } } : {}) });
      }
      trials.push({ selector: field.selector, query, baseline, positive, negative, repeated, blocked: blockedRequests.length > requestStart });
    } finally {
      try { if (await node.count() === 1) { await node.fill(contract.value); await settleJevPage(page); } }
      finally { await page.unroute('**/*', guard); }
    }
  }
  return { assertions, controls: inventory.search, trials, blockedRequests, limitations: 'Only standalone local result filtering is exercised when a result list and matching term are observed. Inputs are restored; no Enter or submit is used. Network-dependent searches and relevance beyond these cases remain untested; request-guard blocks are test limitations, not target failures.' };
}

async function media(page) {
  const before = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  try {
    const images = page.locator('img:visible');
    const imageCount = await images.count();
    const count = Math.min(imageCount, 12);
    const inspectedImages = [];
    for (let i = 0; i < count; i++) {
      const image = images.nth(i);
      await image.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await image.evaluate(element => Promise.race([element.decode().catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000))]));
      if (!await image.evaluate(element => element.complete)) await image.evaluate(element => Promise.race([element.decode().catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000))]));
      inspectedImages.push(await image.evaluate(element => ({ url: element.currentSrc || element.src, complete: element.complete, width: element.naturalWidth, height: element.naturalHeight })));
    }
    const inspected = await page.evaluate(() => ({
      players: [...document.querySelectorAll('audio,video')].slice(0, 10).map(element => ({ url: element.currentSrc || element.src, error: element.error?.code, readyState: element.readyState }))
    }));
    const assertions = [];
    for (const image of inspectedImages.filter(image => image.url)) {
      const passed = image.complete && image.width > 0 && image.height > 0;
      let second;
      // A pending lazy image is not proven broken. Re-load only a completed
      // intrinsic failure, through the same policy-guarded browser context.
      if (!passed && image.complete) second = await page.evaluate(url => new Promise(resolve => {
        const probe = new Image();
        const finish = state => { clearTimeout(deadline); probe.onload = null; probe.onerror = null; resolve({ state, complete: probe.complete, width: probe.naturalWidth, height: probe.naturalHeight }); };
        const deadline = setTimeout(() => finish('timeout'), 3000);
        probe.onload = () => finish('loaded');
        probe.onerror = () => finish('error');
        probe.src = url;
      }), image.url);
      assertions.push({ ...assertion('media', 'Visible image decodes with non-zero dimensions', passed, 'Image completes within the bounded load window with usable intrinsic dimensions', image), ...(!passed ? { reproduction: { confirmed: image.complete && second?.state === 'error' && second.width === 0, observations: second ? 2 : 1, kind: 'image-decode', first: image, second } } : {}) });
    }
    for (const player of inspected.players) assertions.push(assertion('media', 'Media element has no loading error', !player.error, 'No HTMLMediaElement loading error', player));
    return { assertions, ...inspected, images: inspectedImages, truncated: imageCount > 12, limitations: inspected.players.length ? 'Playback, seek, audio output and meeting participation not executed.' : 'Image rendering sample only; pending loads, CSS background images and unsampled assets are not established as broken assets.' };
  } finally { await page.evaluate(position => scrollTo(position.x, position.y), before); }
}

async function disclosure(page, input, onAction) {
  return isolated(page, async blocked => {
    const result = await disclosureLocal(page, input, onAction);
    return blocked.length ? { ...result, assertions: result.assertions.filter(item => item.outcome === 'pass'), blockedRequests: blocked,
      gaps: [...(result.gaps || []), 'Requests were blocked during the disclosure trial. Observed local passing facts are retained, but remote-dependent behavior and apparent failures are unverified.'],
      limitations: 'Local passing DOM facts are retained. Blocked dependencies cannot establish a complete workflow pass or a confirmed target defect.' } : result;
  });
}

async function disclosureLocal(page, input, onAction) {
  const node = page.locator(input.selector);
  const readinessGaps = new Set();
  const settle = async before => {
    const ready = await settleQaControl(page, input.selector, before);
    if (!ready.ready) readinessGaps.add(ready.reason);
  };
  if (await node.count() !== 1) throw new Error('Disclosure selector must be unique.');
  const describe = () => page.evaluate(selector => {
    const element = document.querySelector(selector);
    const visible = element => {
      if (!element?.getClientRects().length || element.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
      for (let node = element; node; node = node.parentElement) { const style = getComputedStyle(node); if (style.visibility === 'hidden' || Number(style.opacity) === 0 || (style.overflowY === 'hidden' && node.getBoundingClientRect().height < 1)) return false; }
      return true;
    };
    const controlled = (element?.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean).map(id => {
      const target = document.getElementById(id);
      return { id, exists: Boolean(target), visible: visible(target), text: target?.innerText?.slice(0, 2000) || '' };
    });
    return { tag: element?.tagName, label: (element?.getAttribute('aria-label') || element?.innerText || '').slice(0, 180), expanded: element?.getAttribute('aria-expanded'), open: element?.closest('details')?.open, controlled, hasForm: Boolean(element?.form), faq: Boolean(element?.closest('[class*="faq" i],[class*="accordion" i]')), body: document.body.innerText.slice(0, 12000) };
  }, input.selector);
  const before = await describe();
  if (before.hasForm || risky.test(before.label) || !(before.tag === 'SUMMARY' || /^(open |close |toggle |show |hide )?(menu|navigation|details|more|faq|help|filters?|accordion)\b/i.test(before.label) || (before.controlled.length && before.expanded !== null) || (before.faq && /\?/.test(before.label)))) throw new Error('Only observed non-destructive disclosure controls are eligible.');
  // Do not force-click hidden or covered controls. This bounded preflight
  // makes stale/mobile-menu candidates explicit gaps without long retries.
  await prepareJevControl(page, input.selector);
  await node.click({ trial: true, timeout: 1500 });
  await node.hover({ timeout: 1500 });
  await settle();
  // Playwright's actionability trial moves the pointer. Hover menus can open
  // here, so compare the click with its actual pre-click state, not an older
  // collapsed state (otherwise a working open->close toggle looks inert).
  const ready = await describe();
  await onAction?.({ phase: 'before', action: 'click', selector: input.selector });
  await node.click({ timeout: 5000 });
  await settle(ready);
  await onAction?.({ phase: 'after', action: 'click', selector: input.selector });
  const after = await describe();
  const changedFrom = (first, second) => first.expanded !== second.expanded || first.open !== second.open || first.body !== second.body || JSON.stringify(first.controlled) !== JSON.stringify(second.controlled);
  let changed = changedFrom(ready, after);
  const declared = before.tag === 'SUMMARY' || ['true', 'false'].includes(before.expanded);
  let repeated;
  if (!changed && declared && await node.count() === 1) {
    await node.click({ timeout: 2000 }); await settle(after); repeated = await describe();
    changed = changedFrom(after, repeated);
  }
  // Leave a proven safe disclosure expanded for frontier discovery. Keyboard
  // activation avoids re-triggering hover and is separately observable.
  if (changed && ready.expanded === 'true' && after.expanded === 'false') {
    await node.press('Enter'); await settle();
  }
  const observations = { label: before.label, before: { expanded: ready.expanded, open: ready.open, controlled: ready.controlled }, hoverChanged: changedFrom(before, ready), recoveredOnRetry: Boolean(repeated && changed), after: { expanded: (repeated || after).expanded, open: (repeated || after).open, controlled: (repeated || after).controlled }, contentChanged: ready.body !== (repeated || after).body };
  const inventory = await inspectJevPage(page);
  // aria-expanded alone is not proof that users received the promised panel.
  const expanded = await describe();
  const missingPanel = state => state.expanded === 'true' && state.controlled.length > 0 && state.controlled.some(panel => !panel.exists || !panel.visible);
  let panelSecond;
  if (missingPanel(expanded)) { await settle(); panelSecond = await describe(); }
  const panelAssertions = expanded.expanded === 'true' && expanded.controlled.length ? [{ ...assertion('navigation', 'Expanded disclosure exposes its declared panel', !missingPanel(expanded), 'Every aria-controls target exists and is visible when expanded', { label: before.label, controlled: expanded.controlled }), ...(missingPanel(expanded) ? { reproduction: { confirmed: missingPanel(panelSecond), observations: 2, kind: 'disclosure-panel', first: expanded.controlled, second: panelSecond.controlled } } : {}) }] : [];
  let restoredInventory;
  const keyboardAssertions = [];
  if (input.restore && await node.count() === 1) {
    const current = await describe();
    if ((before.open !== undefined && current.open !== before.open) || (before.expanded !== null && current.expanded !== before.expanded)) { await node.press('Enter'); await settle(current); }
    await page.mouse.move(0, 0);
    await settle();
    const toggled = (a, b) => a.open !== b.open || a.expanded !== b.expanded;
    const sameToggle = (a, b) => a.open === b.open && a.expanded === b.expanded;
    // A blocked Enter handler on a native button can leave click restoration
    // incomplete. Restore with its already-observed safe click before testing.
    if (!sameToggle(before, await describe())) { const current = await describe(); await node.click({ timeout: 2000 }); await page.mouse.move(0, 0); await settle(current); }
    if (['BUTTON', 'SUMMARY'].includes(before.tag) && declared && toggled(ready, after) && sameToggle(before, await describe())) {
      await node.focus();
      const baseline = await describe();
      await onAction?.({ phase: 'before', action: 'key', selector: input.selector });
      await node.press('Enter'); await settle(baseline);
      const first = await describe();
      const valid = value => toggled(baseline, value) && !missingPanel(value);
      let second;
      if (!valid(first)) { await node.press('Enter'); await settle(first); second = await describe(); }
      const fact = value => ({ label: value.label, expanded: value.expanded, open: value.open, controlled: value.controlled.map(({ id, exists, visible }) => ({ id, exists, visible })) });
      keyboardAssertions.push({ ...assertion('navigation', 'Native disclosure responds to Enter and exposes its declared panel', valid(first), 'The native control reproduces its observed click toggle with Enter and exposes any declared expanded panel', { before: fact(baseline), after: fact(first) }),
        ...(!valid(first) ? { reproduction: { confirmed: Boolean(second && !valid(second) && sameToggle(first, second)), observations: second ? 2 : 1, kind: 'keyboard-disclosure', first: fact(first), second: second && fact(second) } } : {}) });
      await onAction?.({ phase: 'after', action: 'key', selector: input.selector });
      if (!sameToggle(before, await describe())) { const current = await describe(); await node.click({ timeout: 2000 }); await page.mouse.move(0, 0); await settle(current); }
    }
    restoredInventory = await inspectJevPage(page);
  }
  return { assertions: readinessGaps.size ? [] : [{ ...assertion('navigation', 'Disclosure responds to actual click', changed, 'An observable expanded/open/content state change', observations), ...(!changed ? { reproduction: { confirmed: Boolean(declared && repeated && !changedFrom(after, repeated)), observations: repeated ? 2 : 1, kind: 'declared-disclosure', first: observations, second: repeated && { expanded: repeated.expanded, open: repeated.open, controlled: repeated.controlled } } } : {}) }, ...panelAssertions, ...keyboardAssertions], inventory, restoredInventory, ...(readinessGaps.size ? { gaps: [...readinessGaps] } : {}) };
}

async function dismissOverlay(page, input) {
  const inventory = await inspectJevPage(page);
  const overlay = inventory.overlays.find(item => item.close?.selector === input.selector);
  if (!overlay || risky.test(overlay.close.label)) throw new Error('Only an observed close/dismiss button inside a visible dialog is eligible.');
  // Keep element identity: closing onboarding can mount a different dialog at
  // the same structural selector. That replacement is not a failed close.
  const dialog = await page.locator(overlay.selector).elementHandle();
  await page.locator(input.selector).click({ timeout: 3000 });
  const closed = await dialog.waitForElementState('hidden', { timeout: 3000 }).then(() => true, () => false);
  await dialog.dispose();
  await settleJevPage(page);
  return { assertions: [assertion('navigation', 'Observed dialog closes after its close control is activated', closed, 'The original dialog becomes hidden or is detached; any replacement is inspected separately', { label: overlay.close.label, closed })], inventory: await inspectJevPage(page) };
}

export async function runJevBrowserCheck(page, input, { signal, authorizeControl, onAction, onViewport, responsiveBoundaries = false, liveForms = false, requireLiveForms = false, protectInputs } = {}) {
  const startedAt = Date.now();
  if (!page || page.isClosed()) return { success: false, action: input?.action, error: 'No live browser page.' };
  if (!JEV_BROWSER_CHECKS.includes(input?.action)) return { success: false, error: 'Unknown QA scenario.' };
  signal?.throwIfAborted();
  const url = page.url();
  try {
    let result;
    switch (input.action) {
      case 'inspect': result = { inventory: await inspectJevPage(page), assertions: [] }; break;
      case 'navigation': result = await navigation(page, input, onAction); break;
      case 'responsive': result = await responsive(page, { authorizeControl, signal, onAction, onViewport, responsiveBoundaries }); break;
      case 'forms': result = liveForms ? await runLiveFormChecks(page, { signal, onAction, protectInputs }) : requireLiveForms ? { fields: [], assertions: [], gaps: ['The runtime could not verify HTTP, WebSocket and service-worker isolation; live inputs were not modified.'] } : await forms(page); break;
      case 'search': result = await search(page); break;
      case 'media': result = await media(page); break;
      case 'disclosure': result = await disclosure(page, input, onAction); break;
      case 'accessibility': result = await runJevAccessibility(page); break;
      case 'dismiss_overlay': result = await dismissOverlay(page, input); break;
      case 'anchors': result = await runJevAnchors(page, { inspect: inspectJevPage, settle: settleJevPage, prepare: prepareJevControl, authorizeControl, onAction }); break;
      case 'tabs': result = await runJevTabs(page, { inspect: inspectJevPage, settle: settleJevPage, prepare: prepareJevControl, authorizeControl, onAction }); break;
      case 'scroll': result = await exploreScroll(page, signal); break;
    }
    signal?.throwIfAborted();
    return { success: true, action: input.action, url, ...(input.selector ? { selector: input.selector } : {}), ...result, durationMs: Date.now() - startedAt };
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    return { success: false, action: input.action, url, ...(input.selector ? { selector: input.selector } : {}), error: trim(error.message?.split('\nCall log:')[0]), durationMs: Date.now() - startedAt };
  }
}
