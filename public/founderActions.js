/** Per-report UI actions. Server state is authoritative; no mutation or Studio
 * delivery is replayed automatically after a connection failure. */
export function createFounderActionController({ api, getSession, onChange, onExport, schedule = setTimeout, cancel = clearTimeout }) {
  const entries = new Map(); let poll;
  const request = (path, options = {}) => api(path, { ...options, signal: AbortSignal.timeout(options.method ? 45_000 : 15_000) });
  const key = session => session?.mode === 'founder' ? JSON.stringify([session.ownerUserId ?? 'local', session.id, session.founder?.finalizedAt ?? 'pending']) : undefined;
  const entryFor = session => {
    const id = key(session); if (!id) return;
    if (!entries.has(id)) entries.set(id, { key: id, session, state: null, sequence: 0, initialized: false });
    const entry = entries.get(id); entry.session = session; return entry;
  };
  const current = () => entryFor(getSession());
  const bound = entry => entry?.state?.runId === entry?.session.id && entry.state.reviewKey && !entry.state.readOnly;
  const unreconciled = entry => entry.error && entry.lastAction === 'load';
  const body = (entry, ids) => ({ runId: entry.session.id, reviewKey: entry.state.reviewKey, expectedRevision: entry.state.revision, selectedRecommendationIds: ids });
  function notify(entry) {
    if (entry?.key !== key(getSession())) return;
    onChange?.(); cancel(poll); poll = undefined;
    const state = entry.state;
    const waiting = state?.handoff?.status === 'pending' && !state.leaseExpired
      || state?.automaticHandoff && !state.handoff && !state.handoffStartOverdue;
    if (!entry.loading && !entry.sending && !entry.error && waiting) poll = schedule(() => { void load({ force: true, quiet: true }); }, 2000);
  }
  async function fetchState(entry, sequence) {
    const completed = entry.session.founder?.finalizedAt && entry.session.founder?.report;
    const result = await request(`/founder/state${completed ? `?runId=${encodeURIComponent(entry.session.id)}` : ''}`);
    if (entry.sequence !== sequence) return;
    if (completed && (result?.state?.runId !== entry.session.id || !result.state.reviewKey)) throw new Error('The saved selection could not be matched to this report. Reload it before making changes.');
    if (entry.state?.reviewKey === result?.state?.reviewKey && entry.state.revision > result.state.revision) return;
    entry.state = result?.state ?? null; entry.initialized = true;
  }
  async function load({ force = false, quiet = false } = {}) {
    const entry = current(); if (!entry || entry.saving || entry.sending || entry.exporting || entry.initialized && !force) return;
    if (entry.loading) { if (force) entry.refreshRequested = true; return; }
    const sequence = ++entry.sequence; entry.loading = true;
    if (!quiet) entry.error = undefined;
    notify(entry);
    try {
      await fetchState(entry, sequence);
      if (entry.sequence === sequence && entry.lastAction === 'load') entry.error = undefined;
    }
    catch (error) { if (entry.sequence === sequence) { entry.error = error.message; entry.lastAction = 'load'; } }
    finally {
      if (entry.sequence === sequence) {
        entry.loading = false;
        notify(entry);
        if (entry.refreshRequested) {
          entry.refreshRequested = false;
          if (entry.key === key(getSession())) void load({ force: true, quiet: true });
        }
      }
    }
  }
  async function select(ids) {
    const entry = current(); if (!bound(entry) || unreconciled(entry) || entry.loading || entry.saving || entry.sending || entry.exporting || entry.state.automaticHandoff || entry.state.handoff?.status === 'pending') return;
    const sequence = ++entry.sequence; entry.saving = true; entry.error = undefined; entry.failedSelection = undefined; notify(entry);
    try {
      const result = await request('/founder/state/selections', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body(entry, ids)) });
      if (entry.sequence === sequence) { entry.state = result.state; entry.notice = 'Selection saved.'; }
    } catch (error) {
      if (entry.sequence !== sequence) return;
      entry.error = error.status === 409 ? 'The saved selection changed or a delivery is pending. Review the saved selection before changing it again.' : 'Your selection was not saved. Check the connection and retry.';
      entry.lastAction = 'selection'; if (error.status !== 409) entry.failedSelection = [...ids];
      try { await fetchState(entry, sequence); } catch { /* Keep the last acknowledged selection and the retry intent. */ }
    } finally { if (entry.sequence === sequence) { entry.saving = false; notify(entry); } }
  }
  async function send() {
    const entry = current(); if (!bound(entry) || unreconciled(entry) || entry.loading || entry.saving || entry.sending || entry.exporting || !entry.state.selections?.length || entry.state.handoff?.status === 'pending' && !entry.state.leaseExpired) return;
    const sequence = ++entry.sequence, input = body(entry, entry.state.selections);
    entry.sending = true; entry.error = undefined; entry.notice = undefined; notify(entry);
    try {
      const result = await request('/founder/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      if (entry.sequence === sequence) entry.state = result.state;
    } catch (error) {
      if (entry.sequence !== sequence) return;
      entry.error = error.status === 409 ? error.message : 'Studio delivery could not be confirmed. Your saved selection is retained.'; entry.lastAction = 'handoff';
      try { await fetchState(entry, sequence); if (['succeeded','pending','unavailable'].includes(entry.state?.handoff?.status)) entry.error = undefined; }
      catch { entry.error = 'Studio delivery could not be confirmed. Reload its saved status before trying again.'; entry.lastAction = 'load'; }
    } finally { if (entry.sequence === sequence) { entry.sending = false; notify(entry); } }
  }
  async function exportSelection(mode) {
    const entry = current(); if (!bound(entry) || unreconciled(entry) || entry.loading || entry.saving || entry.sending || entry.exporting || !entry.state.selections?.length) return;
    const sequence = ++entry.sequence; entry.exporting = true; entry.error = undefined; notify(entry);
    try {
      const result = await request('/founder/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body(entry, entry.state.selections), export: true }) });
      if (entry.sequence !== sequence) return;
      // If navigation changed, do not copy/download an unexpected report.
      if (entry.key !== key(getSession())) return;
      await onExport(mode, result.payload, entry.session.id);
      entry.notice = mode === 'copy' ? 'Requirements copied. No build was started.' : 'Requirements downloaded. No build was started.';
    } catch (error) {
      if (entry.sequence !== sequence) return;
      entry.error = mode === 'copy' ? 'Could not copy the requirements. Use Download requirements or retry.' : 'Could not export the requirements. Check the connection and retry.'; entry.lastAction = 'export';
    } finally { if (entry.sequence === sequence) { entry.exporting = false; notify(entry); } }
  }
  function snapshot() {
    const entry = current(); if (!entry) return { state: null };
    const state = entry.sending && entry.state ? { ...entry.state, handoff: { status: 'pending', selectedRecommendationIds: entry.state.selections } } : entry.state;
    return { state, loading: Boolean(entry.loading), saving: Boolean(entry.saving), sending: Boolean(entry.sending), exporting: Boolean(entry.exporting), error: entry.error, notice: entry.notice, canRetrySelection: Boolean(entry.failedSelection), lastAction: entry.lastAction, bound: Boolean(bound(entry)) };
  }
  return { load, select, send, export: exportSelection, snapshot, retrySelection: () => { const entry = current(); if (entry?.failedSelection) return select(entry.failedSelection); }, pause() { cancel(poll); poll = undefined; } };
}
