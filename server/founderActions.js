import { randomUUID } from 'node:crypto';
import { canonicalModeHash } from './modeIntegrity.js';
import { projectStateFromSession } from './founderProjectState.js';
import { buildFounderHandoffPayload, FounderHandoffError } from './founderHandoff.js';

const LEASE_MS = 10 * 60_000;
const START_GRACE_MS = 30_000;
const fail = (message, code = 'founder_state_conflict', status = 409) => { throw new FounderHandoffError(message, { code, status }); };
const same = (a, b) => canonicalModeHash([a]) === canonicalModeHash([b]);
const fresh = (handoff, at) => handoff?.status === 'pending' && at - Date.parse(handoff.lastAttemptAt ?? handoff.requestedAt) < LEASE_MS;

export function founderActionSource(session) {
  if (session?.mode !== 'founder' || !session.founder?.report || !session.founder.finalizedAt) fail('Open a completed Founder report before saving or sending recommendations.', 'report_unavailable');
  const source = projectStateFromSession(session);
  source.recommendationSet ??= { setVersion: 0, generatedAt: session.founder.finalizedAt, recommendations: session.founder.report.recommendations ?? [] };
  source.runId = session.id;
  source.automaticStudioHandoff = session.founder.automaticStudioHandoff === true;
  source.reviewKey = canonicalModeHash({ runId: session.id, owner: session.ownerUserId ?? null, finalizedAt: session.founder.finalizedAt, report: session.founder.report, context: source.context, goals: source.goals });
  return structuredClone(source);
}

/** Small action records refer to immutable run reports instead of duplicating
 * every report in the project JSON. Capacity failures never evict saved work. */
export function createFounderActions({ backend, deliveryClient, target, projectId, automaticFounderHandoff = false, now = () => new Date().toISOString() }) {
  if (automaticFounderHandoff && (!deliveryClient || !target)) throw new TypeError('Automatic Founder handoff requires signed Studio delivery.');
  let tail = Promise.resolve();
  const atomic = backend.update ?? (work => {
    const next = tail.then(async () => { const state = await work(await backend.get()); await backend.save(state); return state; });
    tail = next.catch(() => {}); return next;
  });
  const validRecord = record => {
    if (!record || typeof record.runId !== 'string' || !/^[a-f0-9]{64}$/.test(record.reviewKey ?? '') || !Number.isSafeInteger(record.revision) || record.revision < 0 || !Array.isArray(record.selections) || record.selections.length > 50 || !record.selections.every(id => typeof id === 'string' && id.length <= 128) || record.handoffs !== undefined && (!Array.isArray(record.handoffs) || record.handoffs.length > 100)) throw new TypeError('Invalid saved Founder action state. Existing data was preserved.');
    for (const handoff of [...(record.handoffs ?? []), ...(record.handoff ? [record.handoff] : [])]) {
      if (!handoff || !['pending','succeeded','failed','unavailable'].includes(handoff.status) || handoff.intentKey !== undefined && (!/^founder-handoff-[a-f0-9]{64}$/.test(handoff.intentKey) || !Number.isFinite(Date.parse(handoff.requestedAt))) || !Array.isArray(handoff.selectedRecommendationIds) || handoff.selectedRecommendationIds.length > 50 || !handoff.selectedRecommendationIds.every(id => typeof id === 'string' && id.length <= 128)) throw new TypeError('Invalid saved Founder delivery history. Existing data was preserved.');
    }
    return record;
  };
  const records = state => {
    if (state?.actionRecords === undefined) return [];
    if (!Array.isArray(state.actionRecords) || state.actionRecords.length > 500) throw new TypeError('Invalid saved Founder action history. Existing data was preserved.');
    return state.actionRecords.map(validRecord);
  };
  const allRecords = state => [...records(state), state?.legacyAction, ...(!state?.actionRecords ? [state] : [])].filter(Boolean).flatMap(record => [record, ...(record.handoffs ?? []).map(handoff => ({ handoff }))]);
  const publication = source => canonicalModeHash({ owner: source?.ownerUserId ?? null, target: source?.targetUrl ?? null, set: source?.recommendationSet ?? null });
  const canonicalSelection = (source, ids = []) => source.recommendationSet.recommendations.filter(item => ids.includes(item.id)).map(item => item.id);
  const deliveryKey = (source, ids) => `founder-handoff-${canonicalModeHash({ projectId, owner: source.ownerUserId ?? null, runId: source.runId, reviewKey: source.reviewKey, ids })}`;
  const automaticEligible = source => automaticFounderHandoff && source.automaticStudioHandoff === true && source.recommendationSet.recommendations.length > 0;
  const isAutomatic = (source, record) => record.automaticHandoff === true || (automaticEligible(source) && !record.revision && !record.selections.length && !record.handoff);
  const allRecommendations = source => source.recommendationSet.recommendations.map(item => item.id);
  const startOverdue = source => Date.parse(now()) - Date.parse(source.updatedAt) >= START_GRACE_MS;
  function recordFor(state, source) {
    const found = records(state).find(item => item.reviewKey === source.reviewKey && item.runId === source.runId && item.ownerUserId === source.ownerUserId);
    if (found) return found;
    // Old records had no run ID. Migrate only an exact publication match;
    // repeated recommendation IDs alone never carry a selection forward.
    let legacy;
    if (!source.automaticStudioHandoff) {
      legacy = state?.legacyAction?.publication === publication(source) ? state.legacyAction : !state?.actionRecords && state?.recommendationSet && publication(state) === publication(source) ? state : undefined;
    }
    return validRecord({ runId: source.runId, reviewKey: source.reviewKey, ownerUserId: source.ownerUserId, revision: 0, selections: legacy?.selections ?? [], ...(legacy?.handoff ? { handoff: legacy.handoff } : {}) });
  }
  function view(state, source) {
    const record = recordFor(state, source), automaticHandoff = isAutomatic(source, record);
    const handoffStartOverdue = automaticHandoff && !record.handoff && startOverdue(source);
    const selections = handoffStartOverdue ? allRecommendations(source) : canonicalSelection(source, record.selections);
    const handoff = record.handoffs?.find(item => item.intentKey === deliveryKey(source, selections)) ?? record.handoff;
    return { ...source, revision: record.revision, selections, handoff, automaticHandoff, handoffStartOverdue, deliveryConfigured: Boolean(deliveryClient), leaseExpired: handoff?.status === 'pending' && !fresh(handoff, Date.parse(now())) };
  }
  function replace(state, source, record) {
    const actionRecords = records(state).filter(item => item.reviewKey !== source.reviewKey); actionRecords.push(record);
    if (actionRecords.length > 500) fail('Saved Founder actions have reached this project’s capacity. Existing selections were preserved.', 'state_capacity');
    const newer = !state?.recommendationSet || (source.recommendationSet.generatedAt ?? '') >= (state.recommendationSet.generatedAt ?? '');
    let legacyAction = state?.legacyAction;
    if (!state?.actionRecords && state?.recommendationSet) legacyAction = { publication: publication(state), selections: state.selections ?? [], handoff: state.handoff };
    if (!source.automaticStudioHandoff && legacyAction?.publication === publication(source)) legacyAction = undefined;
    const next = { ...(state ?? {}), ...(newer ? source : {}), schemaVersion: 2, actionRecords, legacyAction };
    if (next.reviewKey === source.reviewKey) { next.selections = record.selections; next.handoff = record.handoff; next.revision = record.revision; }
    if (Buffer.byteLength(JSON.stringify(next)) > 1_000_000) fail('Saved Founder actions exceed this project’s capacity. Existing selections were preserved.', 'state_capacity');
    return next;
  }
  function checked(state, source, input) {
    const record = recordFor(state, source);
    if (input?.reviewKey !== source.reviewKey || !Number.isSafeInteger(input?.expectedRevision) || input.expectedRevision !== record.revision) fail('This report or its selections changed. Reload the saved selection before trying again.');
    return record;
  }
  const selected = (source, ids, allowEmpty = false) => {
    if (allowEmpty && Array.isArray(ids) && ids.length === 0) return [];
    return buildFounderHandoffPayload(source, ids, { now: now(), projectId }).selected;
  };
  async function read(session) { const source = founderActionSource(session); return view(await backend.get(), source); }
  async function publish(session) {
    const source = founderActionSource(session);
    if (automaticEligible(source)) {
      return deliverSelection(source, allRecommendations(source));
    }
    await atomic(state => replace(state, source, recordFor(state, source)));
  }
  async function select(session, input) {
    const source = founderActionSource(session), ids = selected(source, input.selectedRecommendationIds, true);
    const next = await atomic(state => {
      const record = checked(state, source, input);
      if (isAutomatic(source, record)) fail('This report’s recommendations are selected automatically.', 'automatic_handoff');
      if (record.handoff?.status === 'pending') fail('A Studio handoff is pending. Wait for its status before changing this selection.', 'handoff_pending');
      return replace(state, source, { ...record, revision: record.revision + 1, selections: ids });
    });
    return view(next, source);
  }
  async function build(session, input) {
    const source = founderActionSource(session), state = await backend.get(); checked(state, source, input);
    return buildFounderHandoffPayload(source, input.selectedRecommendationIds, { now: now(), projectId }).payload;
  }
  async function send(session, input) {
    const source = founderActionSource(session), ids = selected(source, input.selectedRecommendationIds);
    return deliverSelection(source, ids, input);
  }
  async function deliverSelection(source, ids, input) {
    const fromPublication = input === undefined;
    const intentKey = deliveryKey(source, ids);
    let intent, repeated, prior, automatic;
    const reserved = await atomic(state => {
      const record = recordFor(state, source);
      automatic = isAutomatic(source, record);
      if (fromPublication && (!automatic || record.automaticHandoff)) return state;
      if (!fromPublication && input.reviewKey !== source.reviewKey) fail('The published report changed. Reload it before sending.');
      prior = record.handoffs?.find(item => item.intentKey === intentKey) ?? (record.handoff?.intentKey === intentKey || !record.handoff?.intentKey && same(record.handoff?.selectedRecommendationIds, ids) ? record.handoff : undefined);
      if (prior?.status === 'succeeded') { repeated = true; return state; }
      if (!fromPublication) {
        checked(state, source, input);
        if (automatic && !deliveryClient) fail('Studio delivery is unavailable. Use the saved requirements export.', 'handoff_unavailable');
        const savedIds = automatic && !record.handoff && startOverdue(source) ? allRecommendations(source) : canonicalSelection(source, record.selections);
        if (!same(savedIds, ids)) fail('Save this selection before sending it to Studio.', 'selection_not_saved');
      }
      const attemptedAt = now();
      const projectRecords = allRecords(state);
      const busy = projectRecords.some(item => fresh(item.handoff, Date.parse(attemptedAt))) || fresh(record.handoff, Date.parse(attemptedAt));
      const uncertain = [...projectRecords, record].some(item => item.handoff?.status === 'pending' && item.handoff.intentKey !== intentKey);
      const waitMessage = busy ? 'A Founder handoff is already in progress. Wait for it to finish.' : uncertain ? 'An earlier report has an unconfirmed handoff. Open that report to reconcile or retry it before sending another.' : undefined;
      if (waitMessage && !fromPublication) fail(waitMessage, busy ? 'handoff_pending' : 'handoff_uncertain');
      if (!prior && (record.handoffs?.length ?? 0) >= 100) fail('This report has reached its delivery history capacity. Saved work was preserved.', 'handoff_capacity');
      intent = { status: deliveryClient ? 'pending' : 'unavailable', intentKey, attemptId: randomUUID(), requestedAt: prior?.requestedAt ?? attemptedAt, lastAttemptAt: attemptedAt, selectedRecommendationIds: ids };
      if (waitMessage) intent = { ...intent, status: 'failed', failedAt: attemptedAt, message: `${waitMessage} Then retry this delivery.` };
      const handoffs = [...(record.handoffs ?? []).filter(item => item.intentKey !== intentKey), intent];
      return replace(state, source, { ...record, ...(automatic ? { automaticHandoff: true, selections: ids } : {}), revision: record.revision + 1, handoff: intent, handoffs });
    });
    if (repeated) return { ok: true, deduplicated: true, handoff: prior, state: view(reserved, source) };
    if (!intent || intent.status === 'failed') return { ok: false, state: view(reserved, source) };
    const payload = buildFounderHandoffPayload(source, ids, { now: intent.requestedAt, projectId }).payload;
    // Include immutable source identity in both delivery and export contracts.
    payload.recommendationSet.reviewKey = source.reviewKey; payload.sourceRunId = source.runId;
    if (automatic && payload.targetUrl) {
      const url = URL.parse(payload.targetUrl);
      if (url && ['http:', 'https:'].includes(url.protocol)) payload.targetUrl = `${url.origin}${url.pathname}`;
      else delete payload.targetUrl;
    }
    if (!deliveryClient) return { ok: false, unavailable: true, payload, state: view(reserved, source) };
    let outcome;
    try {
      const receipt = await deliveryClient.deliver(target, payload, { idempotencyKey: intentKey, correlationId: intent.attemptId });
      if (!Number.isInteger(receipt?.status) || receipt.status < 200 || receipt.status >= 300 || receipt.body?.ok === false || receipt.body?.accepted === false) throw new Error('Studio did not accept this handoff.');
      const response = receipt.body ?? receipt;
      const candidate = response.reference ?? response.jobId ?? response.threadId ?? response.id;
      const reference = typeof candidate === 'string' || typeof candidate === 'number' ? String(candidate).trim().slice(0, 200) : undefined;
      if (automatic && !reference) throw new Error('Studio did not return a delivery reference.');
      outcome = { ...intent, status: 'succeeded', deliveredAt: now(), ...(reference ? { reference } : {}), upstreamStatus: receipt.status };
    } catch {
      outcome = { ...intent, status: 'failed', failedAt: now(), message: 'Studio delivery could not be confirmed. Your selection is saved. Retry reuses the same delivery key.' };
    }
    // Re-read under the lock. Never write the stale pre-delivery project state.
    const completed = await atomic(state => {
      const record = recordFor(state, source);
      if (record.handoff?.attemptId !== intent.attemptId) return state;
      return replace(state, source, { ...record, revision: record.revision + 1, handoff: outcome, handoffs: [...(record.handoffs ?? []).filter(item => item.intentKey !== intentKey), outcome] });
    });
    if (outcome.status === 'failed' && !fromPublication) fail(outcome.message, 'handoff_failed', 502);
    return { ok: outcome.status === 'succeeded', state: view(completed, source) };
  }
  return { read, publish, select, build: async (session, input) => { const payload = await build(session, input); payload.recommendationSet.reviewKey = input.reviewKey; payload.sourceRunId = session.id; return payload; }, send };
}
