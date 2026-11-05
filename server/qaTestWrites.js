import { randomUUID } from 'node:crypto';

// Owner-authorized test records only. This never grants account/security,
// communication, commerce, deployment or arbitrary script capabilities.
const sensitive = /password|secret|token|card|payment|billing|account|permission|role|invite|send|message|chat|prompt|upload|publish|deploy|subscribe|purchase|checkout|order|login|sign.?in|sign.?up|register|reset|delete|remove|destroy|revoke|users?|members?|organizations?|workspaces?|teams?|meetings?|join/i;
export function createQaTestWrites(session, persist) {
  let active;
  const grant = () => session.qaExecutionMode === 'hybrid' && session.hybrid?.writeAuthorization;
  return {
    async requestDecision(request) {
      if (!active || ['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return null;
      const target = new URL(request.url());
      let ownPage = false; try { ownPage = request.frame().page() === active.page; } catch { /* worker requests never receive a write grant */ }
      const body = request.postData() || '';
      if (!active.armed || active.request || !ownPage || request.method() !== 'POST' || target.href !== active.endpoint || target.origin !== active.origin || sensitive.test(target.pathname) || body.length > 65536 || !body.includes(active.prefix)) return { allowed: false, code: 'QA_TEST_WRITE_OUT_OF_SCOPE' };
      // The page cannot turn a plain native form grant into GraphQL, hidden
      // operations, extra nested payloads or unrelated API mutations.
      let values;
      try {
        const headers = request.headers?.() || {};
        values = /application\/json/i.test(headers['content-type'] || '') ? Object.entries(JSON.parse(body)) : [...new URLSearchParams(body)];
      } catch { return { allowed: false, code: 'QA_TEST_WRITE_PAYLOAD_INVALID' }; }
      if (!values.length || values.some(([name, value]) => typeof value !== 'string' || active.fields.get(name) !== value) || [...active.fields.keys()].some(name => !values.some(([key]) => key === name))) return { allowed: false, code: 'QA_TEST_WRITE_PAYLOAD_OUT_OF_SCOPE' };
      active.request = request; active.trial.status = 'dispatched'; active.trial.dispatchedAt = Date.now();
      active.trial.endpoint = target.origin + target.pathname; active.trial.method = request.method();
      await persist(); // Never dispatch a write without its durable intent.
      return { allowed: true };
    },
    async run(page, selector, signal) {
      const permission = grant();
      if (!permission?.enabled || permission.ownerUserId !== session.ownerUserId || permission.runId !== session.id || !Number.isSafeInteger(permission.maximumSubmissions) || permission.maximumSubmissions < 1 || permission.maximumSubmissions > 10) return { success: false, code: 'QA_TEST_WRITES_NOT_AUTHORIZED', assertions: [], gaps: ['Test-record submission was not authorized in this run setup. Continue available reads and local input cases.'] };
      if (active) throw new Error('A test submission already owns the browser.');
      const form = page.locator(selector);
      if (await form.count() !== 1 || await form.evaluate(e => e.tagName) !== 'FORM') throw new Error('Choose one observed native form.');
      const description = await form.evaluate(form => ({ method: form.method, action: form.action, text: form.innerText.slice(0, 1000),
        hidden: [...form.elements].filter(e => e.type === 'hidden' && !e.disabled).map(e => ({ name: e.name, value: e.value })),
        fields: [...form.elements].filter(e => e.getClientRects().length && !e.disabled && !['submit', 'button', 'hidden'].includes(e.type)).map(e => ({ name: e.name, type: e.type, tag: e.tagName, label: e.getAttribute('aria-label') || e.labels?.[0]?.textContent || '', value: e.value, required: e.required })) }));
      const origin = new URL(session.targetUrl).origin;
      if (new URL(page.url()).origin !== origin || new URL(description.action).origin !== origin || description.method.toLowerCase() !== 'post' || sensitive.test(description.text + ' ' + new URL(description.action).pathname) || !description.fields.length || description.fields.length > 8 || new Set(description.fields.map(f => f.name)).size !== description.fields.length || description.hidden.some(f => !/^(?:_?(?:csrf|xsrf)(?:_?token)?|nonce)$/i.test(f.name)) || description.fields.some(f => !f.name || f.value || sensitive.test(f.name + ' ' + f.label) || !['text', 'email', 'url', 'search', 'textarea'].includes(f.type))) return { success: false, assertions: [], gaps: ['This is not an eligible plain POST form: existing/sensitive/unsupported fields, hidden operations or a different method require an application-specific workflow contract. It was not submitted.'] };
      const identity = `${page.url()}|${selector}`;
      permission.trials ??= [];
      if (permission.trials.some(item => item.identity === identity) || permission.trials.length >= permission.maximumSubmissions) return { success: false, assertions: [], gaps: ['This test form was already attempted or the pinned test-write allocation is exhausted. No write was replayed.'] };
      const trial = { id: randomUUID(), identity, status: 'preparing', createdAt: Date.now() };
      const prefix = `QASE-${session.id.slice(0, 8)}-${permission.trials.length + 1}`;
      trial.testDataPrefix = prefix; permission.trials.push(trial); await persist();
      active = { page, origin, prefix, trial, endpoint: new URL(description.action).href, armed: false, fields: new Map(description.hidden.map(f => [f.name, f.value])) };
      let responsePromise;
      let abort;
      try {
        signal?.throwIfAborted();
        const inputs = form.locator('input:not([type="hidden"]):not([type="submit"]):not([type="button"]),textarea');
        if (await inputs.count() !== description.fields.length) throw new Error('The observed form changed before filling.');
        for (let i = 0; i < description.fields.length; i++) {
          signal?.throwIfAborted();
          const type = description.fields[i].type;
          const value = type === 'email' ? `${prefix}@example.test` : type === 'url' ? `https://example.test/${prefix}` : prefix;
          await inputs.nth(i).fill(value, { timeout: 3000 }); active.fields.set(description.fields[i].name, value);
        }
        if (!await form.evaluate(e => e.checkValidity())) throw new Error('Synthetic test values do not satisfy this form; no submission was attempted.');
        const submit = form.locator('button[type="submit"]:visible,input[type="submit"]:visible,button:not([type]):visible');
        if (await submit.count() !== 1) throw new Error('A unique observed submit button is required.');
        signal?.throwIfAborted(); active.armed = true;
        responsePromise = page.waitForResponse(response => response.request() === active?.request, { timeout: 10000 }); responsePromise.catch(() => {});
        await submit.click({ timeout: 3000 });
        const response = await Promise.race([responsePromise, new Promise((_, reject) => {
          abort = () => reject(signal.reason || new Error('Cancelled'));
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        })]);
        trial.status = 'responded'; trial.httpStatus = response.status(); trial.completedAt = Date.now(); await persist();
        const message='A namespaced test submission was executed. HTTP acknowledgment alone does not prove business success; verify the rendered result against the scenario expectation. Test records may persist and need owner cleanup.';
        return { success: true, assertions: [], writeTesting: { submitted: true, status: trial.status, httpStatus: trial.httpStatus, testDataPrefix: prefix }, gaps: [message],coverageLimitations:[{code:'QA_SUBMISSION_ORACLE_REQUIRED',message}] };
      } catch (error) {
        trial.status = active.request ? 'uncertain' : 'not_dispatched'; trial.completedAt = Date.now(); await persist();
        if (signal?.aborted) throw signal.reason;
        return { success: false, assertions: [], writeTesting: { submitted: Boolean(active.request), status: trial.status, testDataPrefix: prefix }, gaps: [active.request ? 'Test-write outcome is uncertain. Do not replay this form; inspect its state and continue independent reads.' : 'The form could not be safely prepared; no test write was dispatched.'] };
      } finally { if (abort) signal?.removeEventListener('abort', abort); active = undefined; }
    }
  };
}
