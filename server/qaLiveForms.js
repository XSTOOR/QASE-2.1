import { settleQaControl } from './qaRenderReadiness.js';

/** Fixed synthetic cases, not model-generated payloads or business expectations. */
export function liveInputCases(field) {
  if (field.type === 'select-one') return [{ kind: 'empty_selection', value: '' }, ...(field.options || []).slice(0, 2).map(value => ({ kind: 'observed_option', value }))];
  const cases = [{ kind: 'empty', value: '' }, { kind: 'whitespace', value: '   ' }];
  if (field.type === 'email') cases.push({ kind: 'malformed_email', value: 'qase-invalid-email' }, { kind: 'valid_email_syntax', value: 'qase@example.invalid' });
  else if (field.type === 'url') cases.push({ kind: 'malformed_url', value: 'not-a-url' }, { kind: 'valid_url_syntax', value: 'https://example.invalid/' });
  else if (field.type === 'number') {
    const min = field.min !== '' ? Number(field.min) : NaN, max = field.max !== '' ? Number(field.max) : NaN;
    if (Number.isFinite(min)) { if (min - 1 < min) cases.push({ kind: 'below_minimum', value: String(min - 1) }); cases.push({ kind: 'minimum_boundary', value: String(min) }); }
    if (Number.isFinite(max)) { if (max + 1 > max) cases.push({ kind: 'above_maximum', value: String(max + 1) }); cases.push({ kind: 'maximum_boundary', value: String(max) }); }
    const step = field.step ? Number(field.step) : 1, base = Number.isFinite(min) ? min : 0;
    if (Number.isFinite(step) && step > 0 && step < 1000000 && base + step / 2 > base) cases.push({ kind: 'step_mismatch', value: String(base + step / 2) });
    if (!Number.isFinite(min) && !Number.isFinite(max)) cases.push({ kind: 'numeric_value', value: '1' });
  } else {
    cases.push({ kind: 'plain_text', value: 'QASE test' }, { kind: 'unicode', value: 'QASE café 漢字🙂' });
    if (field.minLength > 1 && field.minLength <= 128) cases.push({ kind: 'below_minlength', value: 'a'.repeat(field.minLength - 1) });
    if (field.maxLength >= 0 && field.maxLength < 128) cases.push({ kind: 'maxlength_boundary', value: 'a'.repeat(field.maxLength) }, { kind: 'above_maxlength', value: 'a'.repeat(field.maxLength + 1) });
  }
  return [...new Map(cases.filter(item => field.type !== 'number' || item.kind !== 'whitespace').map(item => [item.value, item])).values()].slice(0, 8);
}

/** The bridge must prove context HTTP/WS/SW guards and retain egress quarantine
 * after return. Never submit, press Enter, use real credentials or edit a
 * prefilled value. Native invalid events/blur are exercised under quarantine. */
export async function runLiveFormChecks(page, { protectInputs, signal, onAction } = {}) {
  if (typeof protectInputs !== 'function' || await page.evaluate(() => Boolean(navigator.serviceWorker?.controller))) return { assertions: [], gaps: ['Live input isolation is unavailable for this document; no field was modified.'] };
  const inventory = await page.evaluate(() => {
    const selector = element => {
      if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) return `#${CSS.escape(element.id)}`;
      const parts = [];
      for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
        const peers = [...(node.parentElement?.children || [])].filter(peer => peer.tagName === node.tagName);
        parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${peers.indexOf(node) + 1})`);
      }
      return parts.join(' > ');
    };
    const nodes = [...document.querySelectorAll('input,textarea,select')].filter(node => {
      if (!node.getClientRects().length || node.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
      for (let parent = node; parent; parent = parent.parentElement) { const style = getComputedStyle(parent); if (style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false; }
      return true;
    });
    return nodes.map(node => ({ selector: selector(node), field: (node.name || node.id || node.type).slice(0, 100), type: node.tagName === 'TEXTAREA' ? 'textarea' : node.type,
      required: node.required, min: node.min ?? '', max: node.max ?? '', step: node.step ?? '', minLength: node.minLength ?? -1, maxLength: node.maxLength ?? -1,
      ...(node.tagName === 'SELECT' ? { options: [...node.options].filter(option => !option.disabled && !option.hidden && option.value).slice(0, 2).map(option => option.value) } : {}),
      safe: ['text', 'email', 'url', 'number', 'textarea', 'tel', 'select-one'].includes(node.tagName === 'TEXTAREA' ? 'textarea' : node.type) && !node.disabled && !node.readOnly && !node.value &&
        (node.tagName !== 'SELECT' || [...node.options].some(option => option.value === '')) &&
        !/password|token|secret|credit|card|cvc|cvv|ssn|otp|one-time|username|login|auth|permission|session|role/i.test(`${node.name} ${node.id} ${node.autocomplete}`) }));
  });
  const eligible = inventory.filter(field => field.safe).slice(0, 6), fields = [], assertions = [], gaps = [];
  if (!eligible.length) return { fields: [], assertions, skipped: 'No empty, non-sensitive editable fields were eligible for live input trials.', formTesting: { mode: 'live_non_submitting', fieldsFilled: 0, casesExecuted: 0, negativeCases: 0, submissionExecuted: false } };
  const blocked = protectInputs(page), blockOffset = blocked.length, blockCount = blocked.total ?? blocked.length;
  const position = await page.evaluate(() => ({ x: scrollX, y: scrollY })), focus = await page.evaluateHandle(() => document.activeElement);
  let casesExecuted = 0, negativeCases = 0, restorationFailed = false;
  try {
    for (const field of eligible) {
      signal?.throwIfAborted();
      const node = page.locator(field.selector), trials = [];
      if (await node.count() !== 1 || !(field.type === 'select-one' ? await node.isEnabled() : await node.isEditable()) || await node.inputValue()) { gaps.push(`${field.field}: field changed or was prefilled before testing; not modified.`); continue; }
      const contract = await node.evaluate(element => JSON.stringify(['type', 'required', 'min', 'max', 'step', 'minlength', 'maxlength', 'pattern'].map(name => [name, element.getAttribute(name)])), undefined, { timeout: 2000 });
      const read = () => node.evaluate(element => ({ value: element.value, valid: element.validity.valid, checkValidity: element.checkValidity(), customError: element.validity.customError,
        failures: ['valueMissing', 'typeMismatch', 'patternMismatch', 'tooShort', 'tooLong', 'rangeUnderflow', 'rangeOverflow', 'stepMismatch', 'customError'].filter(key => element.validity[key]),
        contract: JSON.stringify(['type', 'required', 'min', 'max', 'step', 'minlength', 'maxlength', 'pattern'].map(name => [name, element.getAttribute(name)])) }), undefined, { timeout: 2000 });
      const fill = async value => {
        const handle = await node.elementHandle({ timeout: 2000 });
        if (!handle) throw new Error('Observed input detached');
        try { if (field.type === 'select-one') await handle.selectOption(value, { timeout: 2000 }); else await handle.fill(value, { timeout: 2000 }); await handle.evaluate(element => { if (!element.isConnected) throw new Error('Observed input detached'); element.blur(); }); }
        finally { await handle.dispose(); }
        const ready = await settleQaControl(page, field.selector);
        if (!ready.ready) throw new Error(ready.reason);
        return read();
      };
      try {
        for (const input of liveInputCases(field)) {
          signal?.throwIfAborted();
          const expected = await node.evaluate((element, value) => { const clone = element.cloneNode(true); clone.value = value; return { value: clone.value, valid: clone.validity.valid }; }, input.value, { timeout: 2000 });
          await onAction?.({ phase: 'before', action: 'fill', selector: field.selector });
          const actual = await fill(input.value); casesExecuted++;
          const trial = { kind: input.kind, inputLength: input.value.length, retainedLength: actual.value.length, valid: actual.valid, checkValidity: actual.checkValidity, failures: actual.failures, contractUnchanged: actual.contract === contract };
          // Sanitizers/masks and dynamic requirements need an explicit product
          // specification; a changed value/contract is not a fabricated bug.
          const retained = actual.value === expected.value || (field.maxLength >= 0 && actual.value === input.value.slice(0, field.maxLength));
          if (!retained || actual.contract !== contract) { trial.disposition = 'unverified_transformation'; gaps.push(`${field.field}: ${input.kind} changed value or constraints; product-specific behavior needs a specification.`); }
          else {
            assertions.push({ check: 'forms', name: `${field.field}: live ${input.kind} input is accepted for inspection`, outcome: 'pass', expected: 'The observed editable control retains the synthetic value or native maxlength truncation.', actual: JSON.stringify(trial) });
            const invalid = !expected.valid || (input.kind === 'below_minlength' && actual.value.length > 0) || (input.kind === 'above_maxlength' && actual.value.length > field.maxLength);
            if (invalid) {
              negativeCases++;
              const rejected = !actual.valid && !actual.checkValidity;
              let repeated;
              if (!rejected) { await fill(''); repeated = await fill(input.value); }
              const reproduced = repeated && repeated.value === actual.value && repeated.contract === contract && (repeated.valid || repeated.checkValidity);
              assertions.push({ check: 'forms', name: `${field.field}: live ${input.kind} is rejected by declared constraints`, outcome: rejected ? 'pass' : 'fail', expected: 'Unchanged declared native constraints reject this synthetic negative input.', actual: JSON.stringify(trial),
                ...(!rejected ? { reproduction: { confirmed: Boolean(reproduced), observations: repeated ? 2 : 1, kind: 'live-input-constraint', first: { valid: actual.valid, checkValidity: actual.checkValidity }, second: repeated && { valid: repeated.valid, checkValidity: repeated.checkValidity } } } : {}) });
            }
          }
          trials.push(trial); await onAction?.({ phase: 'after', action: 'fill', selector: field.selector });
        }
      } catch (error) { if (signal?.aborted) throw error; gaps.push(`${field.field}: ${String(error.message).split('\n')[0].slice(0, 200)}`); }
      finally {
        try {
          if (await node.count() !== 1) throw new Error('Control detached');
          if (field.type === 'select-one') await node.selectOption('', { timeout: 2000 }); else await node.fill('', { timeout: 2000 });
          await node.evaluate(element => element.blur(), undefined, { timeout: 2000 }); await settleQaControl(page, field.selector);
          if (await node.inputValue() !== '') throw new Error('Original empty value was not restored');
        } catch { restorationFailed = true; gaps.push(`${field.field}: original empty field state could not be verified restored.`); }
      }
      fields.push({ field: field.field, type: field.type, required: field.required, trials });
      if (restorationFailed) break;
    }
  } finally {
    try { await focus.evaluate(element => { if (element?.isConnected && typeof element.focus === 'function') element.focus({ preventScroll: true }); }); await page.evaluate(point => scrollTo({ left: point.x, top: point.y, behavior: 'instant' }), position); }
    finally { await focus.dispose(); }
  }
  const blockedNetworkAttempts = (blocked.total ?? blocked.length) - blockCount;
  if (blockedNetworkAttempts) gaps.push('Input events attempted blocked network dependencies. Native/local input evidence is recorded, but autosave, remote validation and submission outcomes are not established.');
  if (inventory.length > eligible.length) gaps.push('Prefilled, sensitive, unsupported or excess controls were not modified; remaining inputs are outside this bounded sample.');
  return { fields, assertions: restorationFailed ? [] : assertions, gaps: [...new Set(gaps)], ...(restorationFailed ? { success: false, code: 'QA_INPUT_RESTORE_FAILED' } : {}),
    blockedRequests: blocked.slice(blockOffset), formTesting: { mode: 'live_non_submitting', fieldsFilled: fields.filter(field => field.trials.length).length, casesExecuted, negativeCases, blockedNetworkAttempts, restored: !restorationFailed, submissionExecuted: false, networkIsolation: 'per_document_egress_quarantine' },
    limitations: 'Real fill/input/blur/native invalid events with bounded synthetic empty, malformed, whitespace, Unicode and declared boundary cases. No Enter, submit, credentials or successful remote workflow was tested. Egress quarantine remains active against delayed autosaves until a fresh approved document load.' };
}
