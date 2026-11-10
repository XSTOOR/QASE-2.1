import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { intactQaReceipt } from './qaScenarioScheduler.js';
import { hasConfirmedAccess } from './hybridAuth.js';
import { featureRouteFromTransition } from './qaFeatureState.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const access = session => hasConfirmedAccess(session.hybrid) ? session.hybrid.authentication.grantId : 'public';
const clean = value => String(value || '').slice(0, 180);
export const discoveryRequired = session => session.hybrid?.discovery?.version === 1;
function candidatesFor(inventory, targetUrl) {
  const controls = [...(inventory.navigationControls || []).map(c => ({ ...c, action: 'navigation_control' })), ...(inventory.formOpeners || []).map(c => ({ ...c, action: 'open_test_form' }))];
  const links = (inventory.links || []).filter(c => { try { const u = new URL(c.href); return u.origin === new URL(targetUrl).origin && u.href !== inventory.url && !u.search && !u.hash && !c.download && !c.target && !/login|logout|sign.?out|delete|remove|reset|subscribe|payment|checkout|create|invite|send/i.test(u.pathname + ' ' + c.label); } catch { return false; } }).map(c => ({ ...c, action: 'navigation' }));
  return [...controls, ...links];
}

/** Durable observations, never model-authored facts or permissions. Retain
 * access partitions: a public login inventory cannot qualify an app session. */
export function observeApplication(session, receipt) {
  if (!discoveryRequired(session) || !intactQaReceipt(session, receipt) || !receipt.success) return;
  const d = session.hybrid.discovery, inventory = receipt.result?.inventory;
  if (!inventory?.url || new URL(inventory.url).origin !== new URL(session.targetUrl).origin || !inventory.stateKey) return;
  if (d.observations.some(item => item.evidenceId === receipt.id)) return;
  const auth = access(session), stateKey = inventory.stateKey;
  d.observations.push({ evidenceId: receipt.id, location: inventory.url, stateKey, authenticationContext: auth, ready: inventory.readiness?.ready === true });
  // Do not repeatedly replay a receipt scan on each checkpoint.
  if (d.observations.length > 160) d.observations.shift();
  const add = (kind, name, controls = [], testability = 'observable') => {
    const id = hash([auth, inventory.url, stateKey, kind, clean(name), controls.map(c => c.selector)]);
    let feature = d.features.find(item => item.id === id);
    if (!feature && d.features.length >= 160) d.inventoryTruncated = true;
    if (!feature && d.features.length < 160) {
      feature = { id, kind, name: clean(name), location: inventory.url, stateKey, authenticationContext: auth,
        controls: controls.map(({ selector, label, href, target, download }) => ({ selector, label: clean(label), ...(href ? { href, target, download } : {}) })),
        permissions: kind === 'control' ? 'requires_host_validation' : kind === 'form_opener' || kind === 'form' ? 'input_only_no_submission' : 'authorized_read_only',
        navigationDependencies: [], evidenceRefs: [], confidence: 'observed', testability };
      d.features.push(feature);
    }
    if (feature && !feature.evidenceRefs.includes(receipt.id)) feature.evidenceRefs = [...feature.evidenceRefs, receipt.id].slice(-3);
  };
  add('surface', inventory.headings?.[0] || inventory.title || 'Observed application surface', [], inventory.readiness?.ready === true ? 'observable' : 'loading_blocked');
  for (const [field, kind] of [['navigationControls', 'navigation'], ['tabs', 'tab'], ['disclosures', 'disclosure'], ['formOpeners', 'form_opener'], ['links', 'link'], ['controls', 'control']]) {
    for (const control of (inventory[field] || []).slice(0, 24)) add(kind, control.label || control.href || kind, [control]);
  }
  for (const form of (inventory.forms || []).slice(0, 12)) add('form', 'Observed input form', [form]);
  for (const field of (inventory.search || []).slice(0, 6)) add('search', 'Observed search field', [field]);
  if (inventory.images || inventory.players) add('media', 'Observed images or players');
  if (inventory.authForm) add('authentication', 'Observed authentication boundary', [], 'secure_access_required');
  d.updatedAt = receipt.ts;
}

/** Recompute trust from original receipts. A serialized ready flag is not a
 * certificate; every source must still exist, match this run/access and hash. */
export function applicationDiscoveryStatus(session) {
  if (!discoveryRequired(session)) return { required: false, ready: true };
  const d = session.hybrid.discovery, auth = access(session);
  const valid = new Map(session.hybrid.evidence.filter(e => intactQaReceipt(session, e)).map(e => [e.id, e]));
  const observations = d.observations.filter(o => o.authenticationContext === auth && valid.get(o.evidenceId)?.success &&
    valid.get(o.evidenceId)?.result?.inventory?.stateKey === o.stateKey && valid.get(o.evidenceId)?.result?.inventory?.url === o.location);
  const features = d.features.filter(f => f.authenticationContext === auth && f.evidenceRefs.some(id => {
    const e = valid.get(id), inv = e?.result?.inventory;
    if (!e?.success || inv?.stateKey !== f.stateKey || inv.url !== f.location || f.id !== hash([auth, f.location, f.stateKey, f.kind, f.name, f.controls.map(c => c.selector)])) return false;
    if (f.kind === 'surface') return f.name === clean(inv.headings?.[0] || inv.title || 'Observed application surface');
    const fields = { navigation: 'navigationControls', tab: 'tabs', disclosure: 'disclosures', form_opener: 'formOpeners', link: 'links', form: 'forms', search: 'search', control: 'controls' };
    if (fields[f.kind]) return f.controls.length > 0 && f.controls.every(c => inv[fields[f.kind]]?.some(item => item.selector === c.selector && (!c.href || item.href === c.href)));
    return f.kind === 'media' ? Boolean(inv.images || inv.players) : f.kind === 'authentication' && inv.authForm;
  }));
  const probes = d.probes.filter(p => p.authenticationContext === auth && p.completedAt && p.evidenceId && valid.has(p.evidenceId) &&
    session.hybrid.actions.some(a => a.id === valid.get(p.evidenceId).actionId && a.input?.selector === p.selector && ['navigation_control', 'open_test_form', 'navigation', 'disclosure', 'tabs'].includes(a.input?.action)));
  const current = d.completedAccess === auth;
  // Freeze only the initial gate proof, not the inventory. Later discovery
  // must extend the plan without relocking a scenario already in execution.
  const firstExecution = session.hybrid.evidence.findIndex(e => e.scenarioId);
  const legacyProof = d.observations.filter(o => {
    const index = session.hybrid.evidence.findIndex(e => e.id === o.evidenceId);
    return index >= 0 && (firstExecution < 0 || index < firstExecution);
  }).slice(-12).map(o => o.evidenceId);
  const proof = (d.proofEvidenceIds || legacyProof).map(id => valid.get(id)).filter(e => e?.success && e.result?.inventory?.stateKey);
  const inspected = proof.some(e => e.result.inventory.readiness?.ready === true);
  const candidates = new Set(proof.flatMap(e => candidatesFor(e.result.inventory, session.targetUrl).map(c => hash([e.result.inventory.stateKey, c.action, c.selector, c.href]))));
  const boundedProbes = probes.length >= Math.min(2, candidates.size);
  const blocked = current && d.status === 'blocked' && observations.length > 0;
  return { required: true, ready: Boolean(current && d.status === 'ready' && inspected && features.length && boundedProbes), blocked,
    status: current ? d.status : 'pending', observations: observations.length, features, probes: probes.length,
    limitations: current ? [...(d.limitations || []), ...(d.inventoryTruncated ? ['The bounded feature inventory reached 160 entries; additional observed controls remain unindexed and untested.'] : [])] : [], authenticationContext: auth };
}

export function requireApplicationDiscovery(session) {
  const status = applicationDiscoveryStatus(session);
  if (status.required && !status.ready) throw Object.assign(new Error('Verified application discovery is required before planning or scenario execution. Use qa_discover_application; a claim or invented inventory cannot open the gate.'), { code: 'QA_DISCOVERY_REQUIRED' });
  return status;
}

export function bindDiscoveredPlan(session) {
  const status = requireApplicationDiscovery(session);
  if (!status.required) return;
  for (const scenario of session.hybrid.scenarios.filter(s => s.status === 'planned' && s.required && (!s.discoveryPlan || s.discoveryPlan.authenticationContext !== status.authenticationContext))) {
    const relevant = status.features.filter(f => scenario.category === 'forms' ? ['form', 'form_opener'].includes(f.kind) : scenario.category === 'search' ? f.kind === 'search' : scenario.category === 'media' ? f.kind === 'media' : scenario.category === 'authentication' ? f.kind === 'authentication' : scenario.category === 'navigation' || scenario.category === 'broken_links' ? ['surface', 'navigation', 'link', 'tab', 'disclosure'].includes(f.kind) : f.kind === 'surface');
    if (scenario.discoveryPlan) scenario.priorDiscoveryPlans = [...(scenario.priorDiscoveryPlans || []), scenario.discoveryPlan].slice(-3);
    scenario.discoveryPlan = { authenticationContext: status.authenticationContext, featureIds: relevant.map(f => f.id).slice(0, 24), evidenceRefs: [...new Set(relevant.flatMap(f => f.evidenceRefs))].slice(0, 24),
      applicability: relevant.length ? 'observed' : 'not_yet_observed', retainedRequestedScope: true, createdAt: Date.now() };
    scenario.objective = `${scenario.category}: ${relevant.slice(0, 3).map(f => f.name).join(', ') || 'Investigate the explicitly selected scope on discovered surfaces'}`;
    scenario.plannedActions = ['Navigate via an evidenced feature path', 'Execute matching authorized interactions and host checks', 'Verify state, retain diagnostics and assertions; investigate viable alternatives'];
    scenario.preconditions = ['Verified discovery and authorized access', 'Relevant observed application state is restored'];
    scenario.verificationCriteria = ['Executed host assertions and immutable evidence; absence or missing requirements remain explicit gaps'];
    scenario.requiredEvidence = ['browser state', 'action receipt', 'assertion or evidenced blocker'];
    scenario.priority = ['navigation', 'forms', 'authentication'].includes(scenario.category) ? 'high' : 'normal';
  }
}

/** A bounded composition of registered SDK browser tools. The private owner
 * token grants only discovery reads/navigation, never arbitrary tool access. */
export function createApplicationDiscovery({ session, invoke, checkpoint }) {
  const owners = new AsyncLocalStorage(); let owner;
  const active = () => Boolean(owner && owners.getStore() === owner);
  const summary = status => ({ ...status, featureTotal: status.features?.length || 0, features: status.features?.slice(0, 12), nextOffset: status.features?.length > 12 ? 12 : null });
  const tool = { name: 'qa_discover_application', category: 'qa',
    description: 'Before planning, inspect the real app and probe up to three observed safe navigation controls/pages. Persists features, paths and limitations; no model assumptions, writes or test passes. Reuse discovery across continuation. Call again after access changes or for incremental exploration.',
    parametersSchema: { type: 'object', additionalProperties: false, properties: {} },
    async run(_input = {}, context = {}) {
      if (!discoveryRequired(session)) return { success: true, discovery: { required: false }, message: 'This saved run retains its original execution contract.' };
      if (owner || session.hybrid.currentScenarioId) throw new Error('Release scenario/browser ownership before application discovery.');
      const before = applicationDiscoveryStatus(session);
      if (before.ready) return { success: true, discovery: summary(before) };
      const d = session.hybrid.discovery; owner = Symbol('application-discovery');
      return owners.run(owner, async () => {
        try {
          d.status = 'running'; await checkpoint();
          const current = await invoke('browser_get_url', {}, context.signal);
          if (session.hybrid.recovery?.verificationRequired) {
            await invoke('browser_open', { url: current.url && current.url !== 'about:blank' ? current.url : session.targetUrl }, context.signal);
            await invoke('browser_snapshot', {}, context.signal);
          } else if (!current.url || current.url === 'about:blank') await invoke('browser_open', { url: session.targetUrl }, context.signal);
          let result = await invoke('browser_qa_check', { action: 'inspect' }, context.signal);
          for (let step = 0; step < 3; step++) {
            context.signal?.throwIfAborted();
            let inv = result.inventory;
            const overlay = inv?.overlays?.find(o => o.close && !o.containsForm);
            if (overlay) { result = await invoke('browser_qa_check', { action: 'dismiss_overlay', selector: overlay.close.selector }, context.signal); inv = result.inventory; }
            // A password form is an access boundary, not a ban on inspecting
            // its observed public navigation. Credential submission remains
            // exclusively owned by the secure sign-in tool.
            if (!inv || inv.readiness?.ready !== true || inv.overlays?.length) break;
            const control = candidatesFor(inv, session.targetUrl).find(c => !d.probes.some(p => p.key === hash([access(session), inv.stateKey, c.action, c.selector, c.href])));
            if (!control) break;
            const trial = { key: hash([access(session), inv.stateKey, control.action, control.selector, control.href]), selector: control.selector, label: clean(control.label), stateKey: inv.stateKey, authenticationContext: access(session), startedAt: Date.now() };
            d.probes.push(trial); await checkpoint();
            const parent = session.hybrid.exploration?.routes.find(r => r.stateKey === inv.stateKey && r.url === inv.url && (r.authenticationContext || 'public') === access(session)) || { url: inv.url };
            result = await invoke('browser_qa_check', { action: control.action, selector: control.selector, ...(control.action === 'navigation' ? { expected: control.href } : { restore: false }) }, context.signal);
            trial.evidenceId = result.hostEvidenceId; trial.completedAt = Date.now(); trial.outcome = result.success === false || result.gaps?.length ? 'limited' : 'observed';
            const feature = featureRouteFromTransition(parent, result, access(session));
            if (feature && !session.hybrid.exploration.routes.some(r => r.id === feature.id)) session.hybrid.exploration.routes.push(feature);
            await checkpoint();
            // A pre-dispatch refusal is safe to inspect afresh. A dispatched
            // uncertain outcome is never replayed by discovery.
            if (result.success === false && result.dispatched !== false) break;
            if (!result.inventory) result = await invoke('browser_qa_check', { action: 'inspect' }, context.signal);
          }
          d.completedAccess = access(session);
          d.proofEvidenceIds = d.observations.filter(o => o.authenticationContext === access(session)).slice(-12).map(o => o.evidenceId);
          d.limitations = ['Bounded discovery is not exhaustive coverage. New states extend the inventory during testing; missing requested features remain in the plan.', ...d.probes.filter(p => p.authenticationContext === access(session) && p.outcome === 'limited').map(p => `Navigation probe ${p.label || p.selector} needs investigation; evidence ${p.evidenceId}.`)];
          d.status = 'ready';
          if (!applicationDiscoveryStatus(session).ready) { d.status = 'blocked'; d.limitations.push('The entry surface or viable alternative navigation could not be verified. No execution plan was authorized.'); }
          if (applicationDiscoveryStatus(session).ready) bindDiscoveredPlan(session);
          await checkpoint(); return { success: true, discovery: summary(applicationDiscoveryStatus(session)) };
        } finally { owner = undefined; }
      });
    } };
  return { active, access: () => !owner || active(), tool };
}
