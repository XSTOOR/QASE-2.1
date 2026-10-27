/** Conservative DOM accessibility checks. These inspect authored naming
 * semantics; they do not claim WCAG conformance or simulate a screen reader.
 */
const bounded = value => String(value ?? '').slice(0, 1500);

function observeNaming() {
  const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const hidden = element => {
    if (!element.getClientRects().length) return true;
    for (let node = element; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) return true;
    }
    return false;
  };
  const selector = element => {
    if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) return `#${CSS.escape(element.id)}`;
    const steps = [];
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      const siblings = [...(node.parentElement?.children ?? [])].filter(item => item.tagName === node.tagName);
      const tag = node.tagName.toLowerCase();
      steps.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag);
    }
    return steps.join(' > ');
  };
  // A labelled-by reference can intentionally target visually hidden text.
  // Descendant aria-hidden content, conversely, must not name its button.
  const content = (element, referenced = false, depth = 0) => {
    if (!element || depth > 8) return '';
    if (!referenced && element.getAttribute?.('aria-hidden') === 'true') return '';
    if (element.nodeType === Node.TEXT_NODE) return element.textContent;
    const explicit = element.getAttribute?.('aria-label');
    if (explicit?.trim()) return explicit;
    if (element.tagName === 'IMG') return element.getAttribute('alt') || element.getAttribute('title') || '';
    if (element.tagName?.toLowerCase() === 'svg') return element.querySelector('title')?.textContent || element.getAttribute('title') || '';
    if (['SCRIPT', 'STYLE', 'TEMPLATE'].includes(element.tagName)) return '';
    const pseudo = name => {
      try {
        const value = getComputedStyle(element, name).content;
        return value && !['none', 'normal', '""', "''"].includes(value) ? value.replace(/^['"]|['"]$/g, '') : '';
      } catch { return ''; }
    };
    return `${pseudo('::before')} ${[...element.childNodes].map(node => content(node, referenced, depth + 1)).join(' ')} ${pseudo('::after')}`;
  };
  const name = element => {
    const references = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)).filter(Boolean);
    const referenced = normalize(references.map(node => content(node, true)).join(' '));
    if (referenced) return referenced;
    const explicit = normalize(element.getAttribute('aria-label'));
    if (explicit) return explicit;
    const labels = normalize([...(element.labels ?? [])].map(label => content(label, true)).join(' '));
    if (labels) return labels;
    if (element.tagName === 'INPUT') {
      if (['submit', 'reset'].includes(element.type)) return normalize(element.value) || (element.type === 'submit' ? 'Submit' : 'Reset');
      if (element.type === 'button' && element.value.trim()) return normalize(element.value);
      if (element.type === 'image' && element.getAttribute('alt')?.trim()) return normalize(element.getAttribute('alt'));
    }
    if (['BUTTON', 'A', 'SUMMARY'].includes(element.tagName) || ['button', 'link', 'tab', 'checkbox', 'radio', 'menuitem'].includes(element.getAttribute('role'))) {
      const text = normalize(content(element));
      if (text) return text;
    }
    // Browsers may use title/placeholder as naming fallbacks. Their presence
    // does not establish a visible label, but avoids claiming an absent name.
    return normalize(element.getAttribute('title') || element.getAttribute('placeholder'));
  };
  const controls = [...document.querySelectorAll('button,a[href],input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"]')].filter(element => !hidden(element));
  const images = [...document.querySelectorAll('img,[role="img"]')].filter(element => !hidden(element));
  const observations = [];
  for (const element of controls) observations.push({ kind: 'control', selector: selector(element), tag: element.tagName.toLowerCase(), role: element.getAttribute('role') || element.type || element.tagName.toLowerCase(), name: name(element).slice(0, 180), passes: Boolean(name(element)) });
  for (const element of images) {
    const decorative = ['presentation', 'none'].includes(element.getAttribute('role'));
    const named = name(element);
    // Empty alt explicitly declares decoration and is valid. Whether the
    // image is actually meaningful needs human context and is not inferred.
    const passes = decorative || (element.tagName === 'IMG' && element.hasAttribute('alt')) || Boolean(named);
    observations.push({ kind: 'image', selector: selector(element), tag: element.tagName.toLowerCase(), name: named.slice(0, 180), alt: element.getAttribute('alt'), decorative, passes });
  }
  return { observations: observations.slice(0, 160), total: observations.length };
}

export async function runJevAccessibility(page) {
  const first = await page.evaluate(observeNaming);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const second = await page.evaluate(observeNaming);
  const prior = new Map(first.observations.map(item => [`${item.kind}:${item.selector}`, item]));
  const assertions = second.observations.map(item => {
    const previous = prior.get(`${item.kind}:${item.selector}`);
    const confirmed = !item.passes && previous?.passes === false && previous.tag === item.tag;
    return {
      check: 'accessibility',
      name: item.kind === 'control' ? 'Visible interactive control has an accessible name' : 'Visible image supplies a text alternative or explicit decoration',
      outcome: item.passes ? 'pass' : 'fail',
      expected: item.kind === 'control' ? 'A name from labels, ARIA naming, text content or native naming attributes' : 'An alt attribute, ARIA name, title, or presentation role',
      actual: bounded(JSON.stringify(item)),
      reproduction: { confirmed, kind: 'repeated-dom-naming', observations: 2, first: previous, second: item }
    };
  });
  return {
    assertions, sampledElements: second.observations.length, totalElements: second.total, truncated: second.total > second.observations.length,
    limitations: 'Checks authored control names and image text-alternative declarations only. Empty alt and explicit presentation are accepted without inferring whether an image is meaningful. Visible-label quality, contrast, focus visibility/order, keyboard workflows, shadow DOM, frames and screen-reader behavior were not evaluated.'
  };
}
