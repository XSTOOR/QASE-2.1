import { compareMenuFrames } from './menuFrameComparison.js';
export const MENU_MOTION = 'menu_motion';

// Only the original operator instruction opts in. A later model message,
// continuation, or target page cannot add a control to the allowed scope.
export function menuMotionLabel(session) {
  const kickoff = session.messages?.find(message => message.role === 'user' && message.text?.trim());
  const lines = [...(kickoff?.text.matchAll(/^(?:User focus for this run: )?Menu motion:[ \t]*([^\r\n]{1,120})[ \t]*$/gim) ?? [])];
  return lines.length === 1 ? lines[0][1].trim().replace(/\s+/g, ' ') : undefined;
}

const CLOSED = 0.05;
const OPEN = 0.95;
const NORMAL_MS = 650;
const REDUCED_MS = 150;
const HOLD_MS = 65;
const limitations = 'This checks the named menu’s opacity transition on the current browser and motion preference.';
const inconclusive = (skipped, motion) => ({ assertions: [], skipped, limitations, ...(motion ? { motion } : {}) });

/** Fixed local interaction. The host supplies the approved name and URL,
 * authorizes the observed button, and isolates network side effects. */
export async function runMenuMotion(page, { label, url } = {}, { authorizeControl, protectInputs, saveFrame, signal } = {}) {
  if (!label || page.url() !== url || !authorizeControl || !protectInputs) {
    return inconclusive('Open the authorized target page with a named menu and browser network isolation.');
  }
  const locator = page.getByRole('button', { name: label, exact: true });
  if (await locator.count() !== 1) return inconclusive('The requested menu button was missing or ambiguous.');
  const button = await locator.elementHandle({ timeout: 1500 });
  try {
    const menu = await button.evaluate(element => {
      const panelId = element.getAttribute('aria-controls');
      const panel = panelId && document.getElementById(panelId);
      if (!element.matches('button[type="button"][id]:enabled[aria-expanded="false"]') || element.form
        || document.querySelectorAll(`#${CSS.escape(element.id)}`).length !== 1
        || !panel?.matches('nav,[role="menu"],[role="navigation"]')
        || document.querySelectorAll(`#${CSS.escape(panelId)}`).length !== 1
        || Number(getComputedStyle(panel).opacity) > 0.05 || !panel.getClientRects().length) return null;
      return { selector: `#${CSS.escape(element.id)}`, panelId, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches };
    });
    if (!menu) return inconclusive('The button must start collapsed and declare a unique navigation panel with a measurable closed opacity.');
    signal?.throwIfAborted();
    try { await authorizeControl(menu.selector); }
    catch {
      signal?.throwIfAborted();
      return inconclusive('The requested control is outside safe, read-only menu testing.');
    }
    const blocked = protectInputs(page);
    const initialBlockedCount = blocked.total;
    const deadlineMs = menu.reduced ? REDUCED_MS : NORMAL_MS;
    const motion = { label, panel: menu.panelId, preference: menu.reduced ? 'reduce' : 'no-preference', deadlineMs,
      trials: [], screenshots: [] };
    const frames = [];
    const frame = async phase => {
      if (!saveFrame) return;
      signal?.throwIfAborted();
      try {
        const region = await page.evaluate(id => {
          const box = document.getElementById(id)?.getBoundingClientRect();
          if (!box || box.x < 0 || box.y < 0 || box.right > innerWidth || box.bottom > innerHeight) return null;
          const x = Math.ceil(box.x), y = Math.ceil(box.y);
          return [x, y, Math.floor(box.right) - x, Math.floor(box.bottom) - y];
        }, menu.panelId);
        const bytes = await page.screenshot({ type: 'jpeg', quality: 75, scale: 'css', animations: 'allow', timeout: 1500 });
        signal?.throwIfAborted();
        const artifact = await saveFrame(bytes, phase);
        if (artifact?.artifactId) {
          motion.screenshots.push({ phase, artifactId: artifact.artifactId, capturedAt: artifact.capturedAt });
          frames.push({ bytes, region });
        }
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
      }
    };
    await frame('Before opening');
    for (let i = 0; i < 2; i++) {
      signal?.throwIfAborted();
      const trial = await observeOpening(page, button, { ...menu, url, deadlineMs }, signal);
      if (!trial) return inconclusive('The menu changed before a complete trusted click could be observed.', motion);
      motion.trials.push(trial);
      await frame(i === 0 ? 'After first opening' : 'After second opening');
      if (!await restoreMenu(page, button, { ...menu, url }, signal)) {
        return inconclusive('The menu could not be verified closed again. The sampled opening is preserved for review.', motion);
      }
      if (blocked.total !== initialBlockedCount) return inconclusive('The menu attempted network activity under isolation. Its local motion could not be assessed independently.', motion);
    }
    if (blocked.total !== initialBlockedCount) return inconclusive('The menu attempted network activity during restoration.', motion);
    const [first, second] = motion.trials;
    if (first.reason !== second.reason) return inconclusive('The two openings produced different outcomes.', motion);
    const pass = first.reason === 'met';
    const expected = menu.reduced
      ? `Panel reaches opacity ≥ ${OPEN} within ${deadlineMs} ms without intermediate opacity`
      : `Panel reaches opacity ≥ ${OPEN} within ${deadlineMs} ms through an observed CSS opacity transition`;
    const actual = `${describeResult(first.reason)}. First: ${trialSummary(first)}. Second: ${trialSummary(second)}.`;
    const assertions = [{
      check: MENU_MOTION, name: 'Menu reaches the visible state with its motion preference', expected, actual,
      outcome: pass ? 'pass' : 'fail',
      ...(!pass ? { reproduction: { confirmed: true, observations: 2, kind: 'menu-opacity', first: first.reason, second: second.reason } } : {})
    }];
    if (saveFrame) {
      motion.visual = await compareMenuFrames(frames, signal);
      if (motion.visual.outcome !== 'inconclusive') {
        const [firstChange, secondChange] = motion.visual.changedFractions;
        const visualAssertion = {
          check: MENU_MOTION, name: 'Menu opening visibly changes the panel pixels',
          expected: 'A repeatable change from the closed screenshot within the menu bounds',
          actual: motion.visual.reason, outcome: motion.visual.outcome
        };
        if (motion.visual.outcome === 'fail') {
          visualAssertion.reproduction = {
            confirmed: true, observations: 2, kind: 'menu-pixels', first: firstChange, second: secondChange
          };
        }
        assertions.push(visualAssertion);
      }
    }
    return { limitations, motion, assertions };
  } finally {
    await button.dispose().catch(() => {});
  }
}

async function observeOpening(page, button, { panelId, url, reduced, deadlineMs }, signal) {
  const probe = await button.evaluateHandle((control, options) => {
    const { panelId, url, reduced, deadlineMs, closed, open, hold } = options;
    const panel = document.getElementById(panelId);
    if (location.href !== url || !panel || !control.matches('button[type="button"]:enabled') || control.form || control.getAttribute('aria-controls') !== panelId
      || control.getAttribute('aria-expanded') !== 'false' || Number(getComputedStyle(panel).opacity) > closed) return null;
    const frames = [];
    let resolve, frame, deadline, began, sinceVisible, visibleAtMs, intermediate = false, opacityTransition = false;
    let lastSample = 0;
    const done = new Promise(finish => { resolve = finish; });
    function finish(value) {
      clearTimeout(deadline);
      cancelAnimationFrame(frame);
      control.removeEventListener('click', onClick, true);
      resolve(value);
    }
    function sample() {
      if (location.href !== url || !panel.isConnected || !control.isConnected || control.getAttribute('aria-controls') !== panelId) return finish(null);
      const elapsed = Math.round(performance.now() - began);
      if (elapsed - lastSample > 125) return finish(null);
      lastSample = elapsed;
      const style = getComputedStyle(panel), opacity = Math.round(Number(style.opacity) * 1000) / 1000;
      const box = panel.getBoundingClientRect();
      const expanded = control.getAttribute('aria-expanded') === 'true';
      const visible = expanded && opacity >= open && style.visibility === 'visible' && !panel.closest('[hidden],[inert],[aria-hidden="true"]')
        && box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth
        && panel.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) !== false;
      const transitioning = panel.getAnimations().some(animation => animation.transitionProperty === 'opacity' && animation.playState === 'running');
      if (frames.length < 64) frames.push({ elapsedMs: elapsed, opacity, visible, transitioning });
      intermediate ||= opacity > closed && opacity < open;
      opacityTransition ||= transitioning;
      sinceVisible = visible ? sinceVisible ?? elapsed : undefined;
      if (sinceVisible !== undefined && elapsed - sinceVisible >= hold) visibleAtMs = sinceVisible;
      if (visibleAtMs !== undefined || elapsed >= deadlineMs + hold) {
        const reason = visibleAtMs === undefined || visibleAtMs > deadlineMs ? 'late_or_hidden'
          : reduced ? intermediate || opacityTransition ? 'motion_with_reduction' : 'met'
            : intermediate && opacityTransition ? 'met' : 'transition_not_observed';
        return finish({ reason, visibleAtMs: visibleAtMs ?? null, finalOpacity: opacity, frames });
      }
      frame = requestAnimationFrame(sample);
    }
    function onClick(event) {
      if (!event.isTrusted || began !== undefined) return;
      began = performance.now();
      clearTimeout(deadline);
      deadline = setTimeout(() => finish(null), deadlineMs + hold + 1000);
      frame = requestAnimationFrame(sample);
    }
    control.addEventListener('click', onClick, true);
    deadline = setTimeout(() => finish(null), 4500);
    return { done, cancel: () => finish(null) };
  }, { panelId, url, reduced, deadlineMs, closed: CLOSED, open: OPEN, hold: HOLD_MS });
  try {
    if (!await probe.evaluate(watch => watch !== null)) return null;
    signal?.throwIfAborted();
    await button.click({ timeout: 2500 });
    signal?.throwIfAborted();
    return await probe.evaluate(watch => watch.done);
  } finally {
    await probe.evaluate(watch => watch?.cancel()).catch(() => {});
    await probe.dispose().catch(() => {});
  }
}

async function restoreMenu(page, button, { panelId, url }, signal) {
  if (page.url() !== url) return false;
  const state = await button.evaluate((control, id) => control.isConnected && control.matches('button[type="button"]:enabled') && !control.form && control.getAttribute('aria-controls') === id
    ? control.getAttribute('aria-expanded') : null, panelId);
  if (state === 'true') {
    signal?.throwIfAborted();
    await button.click({ timeout: 2500 });
  } else if (state !== 'false') return false;
  try {
    await page.waitForFunction(({ id, url, control, closed }) => {
      const panel = document.getElementById(id);
      return location.href === url && panel && control.isConnected && control.getAttribute('aria-expanded') === 'false'
        && Number(getComputedStyle(panel).opacity) <= closed;
    }, { id: panelId, url, control: button, closed: CLOSED }, { timeout: 1250 });
    return true;
  } catch {
    return false;
  }
}

const describeResult = reason => ({
  met: 'The panel opened as expected',
  late_or_hidden: 'The panel did not reach a stable visible state within the deadline',
  motion_with_reduction: 'The panel animated with reduced motion enabled',
  transition_not_observed: 'The panel opened without an observable CSS opacity transition'
})[reason];
const trialSummary = trial => `${trial.visibleAtMs === null ? 'never reached visible state' : `visible at ${trial.visibleAtMs} ms`}, final opacity ${trial.finalOpacity}`;
