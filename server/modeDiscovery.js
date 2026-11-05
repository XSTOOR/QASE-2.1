import { AsyncLocalStorage } from 'node:async_hooks';
import {canonicalModeHash,legacyModeHash,modeReceiptHash} from './modeIntegrity.js';

const hashFor=(session,value)=>(execution(session).discovery?.hashVersion===1?canonicalModeHash:legacyModeHash)(value);
const text = (value, limit = 180) => String(value || '').slice(0, limit);
const FIELDS = ['links', 'navigationControls', 'tabs', 'disclosures', 'forms', 'search', 'controls'];
const RISKY = /logout|sign.?out|delete|remove|reset|purchase|checkout|payment|subscribe|create|invite|send|save|deploy|publish|destroy|revoke/i;
const ASSET = /\.(?:pdf|zip|csv|json|xml|png|jpe?g|gif|svg|webp|mp[34]|webm|woff2?|exe|dmg)$/i;
export const modeDiscoveryRequired = session => session?.[session.mode]?.execution?.discovery?.version === 1;
export const modeWorkflowSummary = ({verification,...workflow}) => workflow;
const execution = session => session[session.mode].execution;

function safeUrl(href, target) {
 if(typeof href!=='string'||!href.trim()||href.length>2048)return null;
 try {
  const url = new URL(href, target);
  return url.origin === new URL(target).origin && !url.search && !url.username && !url.password && !RISKY.test(url.pathname) && !ASSET.test(url.pathname) ? url.href : null;
 } catch { return null; }
}

function inventoryOf(result, target) {
 const source = result?.inventory;
 if (result?.success === false || !source?.stateKey || !safeUrl(source.url, target)) return null;
 const inventory = { url: source.url, stateKey: text(source.stateKey, 128), title: text(source.title),
  ready: source.readiness?.ready === true, authBoundary: Boolean(source.authForm), headings: (source.headings || []).slice(0, 4).map(s => text(s)) };
 for (const field of FIELDS) {
  // Spend the bounded link inventory on unique authorized destinations.
  // Repeated header links or external CTAs must not hide the same-origin
  // routes which the host's exploration gate later requires.
  const values=field==='links'?(source.links||[]).filter(c=>safeUrl(c.href,target)&&!c.download&&(!c.target||c.target==='_self')).filter((c,i,all)=>all.findIndex(other=>other.href===c.href)===i):(source[field]||[]);
  inventory[field] = values.slice(0, 12).map(c => ({ selector: text(c.selector, 400), label: text(c.label),
  ...(c.href && safeUrl(c.href, target) ? { href: safeUrl(c.href, target) } : {}), target: text(c.target, 20), download: Boolean(c.download) }));
 }
 return JSON.stringify(inventory).length <= 20000 ? inventory : null;
}

function intact(session, receipt) {
 const state = execution(session);
 return receipt.digest === hashFor(session,[session.id, session.mode, receipt.actionId, receipt.activityId, receipt.inventory])
  && state.actions.some(a => a.id === receipt.actionId && a.status === 'done' && a.tool === 'browser_qa_check')
  && session.activities.some(a => a.id === receipt.activityId && a.toolName === 'browser_qa_check' && a.status === 'done');
}

function featuresFrom(receipts,hash) {
 return receipts.flatMap(r => {
  const inv = r.inventory;
  return [{ kind: 'surface', name: inv.headings[0] || inv.title || 'Observed surface', controls: [] },
   ...FIELDS.flatMap(kind => inv[kind].filter(c => c.selector).map(c => ({ kind, name: c.label || kind, controls: [c] })))].map(f => ({
    ...f, id: hash([inv.url, inv.stateKey, f.kind, f.name, f.controls]).slice(0, 24), location: inv.url, stateKey: inv.stateKey,
    evidenceId: r.id, activityId: r.activityId, confidence: 'observed', permissions: f.kind === 'forms' || f.kind === 'search' ? 'input_only_no_submission' : 'host_validated_read_only',
    testability: inv.authBoundary ? 'authentication_boundary' : inv.ready ? 'observable' : 'rendering_blocked'
   }));
 }).filter((f, index, all) => all.findIndex(other => other.id === f.id) === index).slice(0, 160);
}

function receiptActivityValid(session,receipt) {
 return session.activities.some(a=>a.id===receipt.activityId&&a.toolName===receipt.tool&&
  (a.status==='done'||a.status==='failed'&&receipt.result.success===false));
}
function workflowProofValid(session, workflow) {
 const proof = workflow.verification;
 if (!proof || proof.digest !== hashFor(session,[workflow.id,workflow.feature_ids,workflow.steps,workflow.expected_behavior,workflow.status,proof.receipts])) return false;
 return proof.receipts.length > 0 && proof.receipts.every(e => e.workflowId === workflow.id && e.digest === modeReceiptHash(e)
  && execution(session).actions.some(a => a.id === e.actionId && a.status === 'done' && a.tool === e.tool)
  && receiptActivityValid(session,e));
}

export function modeDiscoveryStatus(session) {
 if (!modeDiscoveryRequired(session)) return { required: false, ready: true, features: [] };
 const d = execution(session).discovery;
 const receipts = d.receipts.filter(r => intact(session, r));
 const proof = d.proofIds?.map(id => receipts.find(r => r.id === id)).filter(Boolean) || [];
 const features = featuresFrom(receipts,value=>hashFor(session,value));
 return { required: true, ready: d.status === 'ready' && Boolean(proof.length && proof.length === d.proofIds.length && proof.some(r => r.inventory.ready) && features.length),
  status: d.status, features, limitations: d.limitations, inspectedSurfaces: new Set(receipts.map(r => r.inventory.url + r.inventory.stateKey)).size };
}

export function modeDiscoverySummary(session) {
 const status=modeDiscoveryStatus(session);
 if(!status.required)return status;
 const surfaces=status.features.filter(f=>f.kind==='surface');
 return {...status,featureCount:status.features.length,features:[...surfaces,...status.features.filter(f=>f.kind!=='surface')].slice(0,20),nextOffset:status.features.length>20?20:null};
}

/** Bind an agent's control claim to checks executed for that planned control,
 * never to an arbitrary recent screenshot. Documentary review is unchanged. */
export function modeSqaEvidenceActivityIds(session,controlId) {
 if(!modeDiscoveryRequired(session))return null;
 const technical=/^SQA-WEB-00[1-6]$/.test(controlId);
 const state=execution(session), workflows=(state.workflows||[]).filter(w=>technical||w.control_ids?.includes(controlId));
 const candidates=[...state.evidence,...workflows.flatMap(w=>w.verification?.receipts||[])];
 const checks={'SQA-WEB-001':['inspect'],'SQA-WEB-002':['navigation','navigation_control','tabs','disclosure'], 'SQA-WEB-003':['forms'], 'SQA-WEB-004':['accessibility'],'SQA-WEB-006':['responsive']};
 return new Set(candidates.filter(e=>workflows.some(w=>w.id===e.workflowId)&&e.digest===modeReceiptHash(e)&&state.actions.some(a=>a.id===e.actionId&&a.status==='done'&&
  (controlId==='SQA-WEB-005'?a.tool==='browser_diagnostics':controlId==='SQA-WEB-001'?a.tool==='browser_qa_check'&&Boolean(e.result.stateKey&&e.result.bodyText?.trim()):checks[controlId]?a.tool==='browser_qa_check'&&checks[controlId].includes(a.intent?.action)&&e.result.assertions?.length>0:a.tool.startsWith('browser_')))).map(e=>e.activityId));
}

export function modeSqaHasFailedAssertions(session,controlId) {
 const allowed=modeSqaEvidenceActivityIds(session,controlId);
 if(!allowed||!/^SQA-WEB-00[1-6]$/.test(controlId))return false;
 const state=execution(session);
 return [...state.evidence,...(state.workflows||[]).flatMap(w=>w.verification?.receipts||[])].some(e=>allowed.has(e.activityId)&&e.digest===modeReceiptHash(e)&&
  (e.result.assertionCounts?.failed>0||e.result.assertions?.some(a=>a.outcome==='fail')));
}

export function modeWorkReadiness(session) {
 const discovery = modeDiscoveryStatus(session);
 if (!discovery.required) return { ready: true };
 const state = execution(session), workflows = state.workflows || [];
 const pending = workflows.filter(w => !['passed', 'failed', 'blocked', 'inconclusive'].includes(w.status));
 const invalid = workflows.filter(w => !pending.includes(w) && !workflowProofValid(session,w)).map(w=>w.id);
 const surfaces = new Set(discovery.features.filter(f=>f.kind==='surface').map(f=>f.location+f.stateKey));
 const plannedSurfaces = new Set(workflows.flatMap(w=>(w.feature_ids||[]).flatMap(id=>{
  const feature=discovery.features.find(f=>f.id===id);if(!feature)return [];
  return [feature.location+feature.stateKey,...feature.controls.flatMap(c=>w.verification?.receipts.filter(e=>e.result.url===c.href).map(e=>c.href+(e.result.stateKey||'observed-route'))||[])];
 })));
 return { ready: discovery.ready && !state.recoveryRequired && !state.actions.some(a=>a.status==='uncertain') && workflows.length > 0 && !pending.length && !invalid.length && plannedSurfaces.size>=Math.min(2,surfaces.size) && !state.currentWorkflowId && Boolean(state.classifications.length),
  discoveryReady: discovery.ready, planned: workflows.length, attempted: workflows.filter(w => w.evidenceIds?.length).length,
  invalidProofIds:invalid,requiredWorkflowSurfaces:Math.min(2,surfaces.size),plannedSurfaces:plannedSurfaces.size,
  pending: pending.map(w => ({ id: w.id, title: w.title, status: w.status })), classificationRequired: !state.classifications.length,
  counts: Object.fromEntries(['planned', 'running', 'passed', 'failed', 'blocked', 'inconclusive'].map(status => [status, workflows.filter(w => w.status === status).length])) };
}

export function validateModeFinding(session,input) {
 const state=execution(session);
 const receipt=[...state.evidence,...(state.workflows||[]).flatMap(w=>w.verification?.receipts||[])].find(e=>e.id===input.mode_evidence_id);
 const assertion=receipt?.result.assertions?.find(a=>a.name===input.assertion_name&&a.outcome==='fail');
 if(!assertion||receipt.digest!==modeReceiptHash(receipt)||!state.actions.some(a=>a.id===receipt.actionId&&a.status==='done')||!session.activities.some(a=>a.id===receipt.activityId&&a.status==='done'&&a.toolName?.startsWith('browser_')))throw new TypeError('A confirmed finding requires an intact failed host assertion and its actual browser activity; prose or JEV agreement cannot confirm a defect.');
 return {expected:assertion.expected,actual:assertion.actual,url:receipt.result.url,evidence:`${assertion.name}: ${assertion.actual}\nqase://runs/${session.id}/activities/${receipt.activityId}/mode-evidence/${receipt.id}#${receipt.digest}`};
}

export function modeExplorationReadiness(session) {
 const state=session[session.mode]?.execution;
 if(!state)return {ready:true};
 const requiredPages=Math.min(state.depthContractVersion===2?8:3,Math.max(1,state.routes?.length||1));
 const reviewedPages=state.routes?.filter(r=>r.reviewed).length||0;
 const completed=state.actions.filter(a=>a.status==='done');
 const interaction=completed.some(a=>a.interaction),diagnostics=completed.some(a=>a.tool==='browser_diagnostics');
 const uncertain=state.actions.some(a=>['running','uncertain'].includes(a.status)&&a.tool.startsWith('browser_'));
 const work=modeWorkReadiness(session);
 const features=modeDiscoveryStatus(session).features;
 const nextRoutes=(state.routes||[]).filter(r=>!r.reviewed).slice(0,Math.max(0,requiredPages-reviewedPages)).map(r=>{
  const feature=features.find(f=>f.controls.some(c=>c.href?.split('#')[0]===r.url));
  return {url:r.url,featureId:feature?.id,sourceUrl:feature?.location};
 });
 return {ready:reviewedPages>=requiredPages&&interaction&&diagnostics&&!uncertain&&work.ready,reviewedPages,requiredPages,nextRoutes,interaction,diagnostics,uncertain,work};
}

/** One native SDK owner executes bounded compositions of existing approved
 * browser tools. No model-authored inventory, script, permission or verdict. */
export function createModeDiscovery({ session, state, invoke, checkpoint,toolNames=()=>[] }) {
 const hash=value=>hashFor(session,value);
 const scope = new AsyncLocalStorage(); let owner;
 const internal = () => Boolean(owner && scope.getStore() === owner);
 const fail = (code, error) => ({ success: false, code, error });
 const owned = async work => {
  if (owner) throw new Error('Mode browser ownership is already held.');
  owner = Symbol('mode-discovery');
  try { return await scope.run(owner, work); } finally { owner = undefined; }
 };
 const observe = (receipt, result) => {
  if (!modeDiscoveryRequired(session) || receipt.tool !== 'browser_qa_check') return;
  const inventory = inventoryOf(result, session.targetUrl), d = state.discovery;
  if (!inventory || !receipt.activityId || d.receipts.some(r => r.inventory.url === inventory.url && r.inventory.stateKey === inventory.stateKey)) return;
  if (d.receipts.length >= 24) { d.limitations = ['Bounded discovery inventory reached 24 application states; additional scope remains unindexed.']; return; }
  const saved = { id: receipt.id, actionId: receipt.actionId, activityId: receipt.activityId, inventory };
  saved.digest = hash([session.id, session.mode, saved.actionId, saved.activityId, inventory]); d.receipts.push(saved);
 };
 const refusal = (name,input) => {
  if (!modeDiscoveryRequired(session)) return;
  if(name==='ask_question'&&state.phase==='coverage_recovery'&&/(?:tools?.{0,100}(?:not|unavailable|expos|list)|host.{0,100}(?:retry|expos))/i.test(String(input?.question||'')+' '+String(input?.summary||'')))return {...fail('MODE_HOST_CONTINUATION_REQUIRED','This is an internal host capability question, not a new user authorization requirement. Use mode_plan_work with the next observed route/feature below, then mode_run_workflow. classify_mode_observations remains available for intact evidence. Do not ask the user to override completion gates.'),exploration:modeExplorationReadiness(session)};
  if(state.recoveryRequired&&!internal()&&!['mode_verify_recovery','mode_execution_progress','ask_question'].includes(name))return fail('MODE_RECOVERY_REQUIRED','Verify the interrupted browser state with mode_verify_recovery before further work. No uncertain action may be replayed.');
  if (['update_todo', 'record_sqa_control', 'record_sqa_blockers', 'record_founder_observation', 'finish_sqa_assessment', 'finish_founder_review', 'draft_founder_report_section'].includes(name)) {
   if (!modeDiscoveryStatus(session).ready) return fail('MODE_DISCOVERY_REQUIRED', 'Call mode_discover_application before planning or recording conclusions. Discovery must reference intact browser receipts.');
   if (!state.workflows?.length && name !== 'update_todo') return fail('MODE_PLAN_REQUIRED', 'Create the evidence-linked workflow plan with mode_plan_work before recording conclusions.');
  }
 };
 const tool = (name, description, properties, required, run) => ({ name, category: session.mode, description,
  parametersSchema: { type: 'object', additionalProperties: false, properties, required }, run });
 const discover = tool('mode_discover_application', 'FIRST: inspect the entry and probe at most three observed safe routes or SPA controls. Persists a reusable, evidence-backed feature inventory; never invents features, passes or permissions.', {}, [], async (_input, context = {}) => owned(async () => {
  if (modeDiscoveryStatus(session).ready) return { success: true, discovery: modeDiscoverySummary(session) };
  state.discovery.status = 'running'; await checkpoint();
  const current = await invoke('browser_get_url', {}, context.signal);
  if (!current.url || current.url === 'about:blank') await invoke('browser_open', { url: session.targetUrl }, context.signal);
  let result = await invoke('browser_qa_check', { action: 'inspect' }, context.signal);
  const probes = new Set();
  for (let step = 0; step < 3; step++) {
   context.signal?.throwIfAborted();
   const inv = result?.inventory;
   if (!inv?.readiness?.ready || inv.overlays?.length) break;
   const candidates = [...(inv.navigationControls || []).map(c => ({ ...c, action: 'navigation_control' })),
    ...(inv.tabs || []).map(c => ({ ...c, action: 'tabs' })), ...(inv.disclosures || []).map(c => ({ ...c, action: 'disclosure' })),
    ...(inv.links || []).filter(c => safeUrl(c.href, session.targetUrl) && c.href !== inv.url && !new URL(c.href, inv.url).hash && !c.target && !c.download).map(c => ({ ...c, action: 'navigation' }))];
   const candidate = candidates.find(c => c.selector && !RISKY.test(c.label || '') && !probes.has(c.selector + (c.href || '')));
   if (!candidate) break;
   probes.add(candidate.selector + (candidate.href || ''));
   result = await invoke('browser_qa_check', { action: candidate.action, selector: candidate.selector, ...(candidate.action === 'navigation' ? { expected: candidate.href } : { restore: false }) }, context.signal);
   if (result?.success === false) break;
  }
  const d = state.discovery;
  d.proofIds = d.receipts.filter(r => intact(session, r)).map(r => r.id);
  d.status = d.receipts.some(r => intact(session, r) && r.inventory.ready) ? 'ready' : 'blocked';
  if (d.status === 'blocked') d.limitations = ['The authorized entry did not produce a verified rendered inventory. Access or rendering requires review.'];
  await checkpoint();
  return { success: d.status === 'ready', discovery: modeDiscoverySummary(session) };
 }));
 const strings = { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', maxLength: 500 } };
 const plan = tool('mode_plan_work', 'After discovery, add 1–8 application-specific workflows referencing observed feature IDs. Preserve user requirements, canonical mode todos and prior work. Model planning is not execution.', {
  workflows: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, properties: {
   id: { type: 'string', maxLength: 80 }, title: { type: 'string', maxLength: 180 }, feature_ids: strings, steps: strings,
   expected_behavior: { type: 'string', maxLength: 1200 }, control_ids: {...strings,maxItems:50},
   depends_on: { type: 'array', maxItems: 8, items: { type: 'string' } }
  }, required: ['id', 'title', 'feature_ids', 'steps', 'expected_behavior'] } }
 }, ['workflows'], async input => {
  const discovery = modeDiscoveryStatus(session);
  if (!discovery.ready) return fail('MODE_DISCOVERY_REQUIRED', 'Discover the application before planning.');
  const next = structuredClone(state.workflows || []), ids = new Set(next.map(w => w.id));
  if(!Array.isArray(input?.workflows)||!input.workflows.length||input.workflows.length>8)return fail('MODE_PLAN_INVALID','Supply 1–8 bounded workflows.');
  for (const w of input.workflows) {
   if(!w||typeof w!=='object'||typeof w.id!=='string'||typeof w.title!=='string'||typeof w.expected_behavior!=='string'||!Array.isArray(w.steps)||!Array.isArray(w.feature_ids)||w.control_ids!==undefined&&!Array.isArray(w.control_ids)||w.depends_on!==undefined&&!Array.isArray(w.depends_on))return fail('MODE_PLAN_INVALID','Use typed workflow fields and actual feature-ID arrays.');
   if (!w.id?.trim() || ids.has(w.id) || !w.title?.trim() || !w.expected_behavior?.trim() || !w.steps?.length || !w.feature_ids?.length || w.feature_ids.some(id => !discovery.features.some(f => f.id === id)) || w.depends_on?.some(id => !ids.has(id))) return fail('MODE_PLAN_INVALID', 'Use unique workflow IDs, actual feature IDs, nonempty steps/expectations, and earlier dependencies.');
   if (session.mode === 'sqa' && w.control_ids?.some(id => !session.sqa.scope.applicableControlIds.includes(id))) return fail('MODE_CONTROL_SCOPE', 'Plan only controls in the assessment scope.');
   if(w.id.length>80||w.title.length>180||w.expected_behavior.length>1200||w.steps.length>8||w.feature_ids.length>8||w.steps.some(s=>typeof s!=='string'||!s.trim()||s.length>500)||w.control_ids?.length>50||w.depends_on?.length>8)return fail('MODE_PLAN_INVALID','Workflow fields exceed their documented bounds.');
   ids.add(w.id); next.push({ id:w.id,title:w.title,feature_ids:w.feature_ids,steps:w.steps,expected_behavior:w.expected_behavior,...(w.control_ids?{control_ids:w.control_ids}:{}),...(w.depends_on?{depends_on:w.depends_on}:{}),status: 'planned', plannedAt: Date.now(), evidenceIds: [] });
  }
  if (next.length > 16) return fail('MODE_PLAN_LIMIT', 'The bounded plan allows at most 16 workflows; preserve completed work.');
  state.workflows = next;state.phase='execution'; await checkpoint(); return { success: true, workflows: next.map(modeWorkflowSummary) };
 });
 const start = tool('mode_start_workflow', 'Activate a planned workflow before its browser checks. Completed workflows are never replayed; dependencies must be passed.', { id: { type: 'string' } }, ['id'], async ({ id }) => {
  const w = state.workflows?.find(w => w.id === id);
  if (!modeDiscoveryStatus(session).ready || !w || !['planned', 'running'].includes(w.status) || state.currentWorkflowId && state.currentWorkflowId !== id || w.depends_on?.some(id => state.workflows.find(w => w.id === id)?.status !== 'passed')) return fail('MODE_WORKFLOW_NOT_READY', 'Choose a pending observed workflow with satisfied dependencies; finish the current workflow first.');
  w.status = 'running'; w.startedAt ??= Date.now(); state.currentWorkflowId = id; await checkpoint(); return { success: true, workflow: w };
 });
 const close = tool('mode_close_workflow', 'Close the active workflow using its actual host assertion receipts. Pass/fail is derived from executed assertions, never model agreement. Blocked/inconclusive needs an observed tool gap and precise reason.', {
  id: { type: 'string' }, disposition: { type: 'string', enum: ['verified', 'blocked', 'inconclusive'] }, reason: { type: 'string', maxLength: 1200 }
 }, ['id', 'disposition'], async ({ id, disposition, reason }) => {
  const w = state.workflows?.find(w => w.id === id);
  if (!w || w.status !== 'running' || state.currentWorkflowId !== id) return fail('MODE_WORKFLOW_NOT_RUNNING', 'Activate the workflow before closing it.');
  const receipts = state.evidence.filter(e => e.workflowId === id && e.tool.startsWith('browser_') && e.digest === modeReceiptHash(e) && state.actions.some(a => a.id === e.actionId && a.status === 'done') && receiptActivityValid(session,e));
  const features=modeDiscoveryStatus(session).features.filter(f=>w.feature_ids.includes(f.id));
  const relevant=receipts.filter(e=>features.some(f=>f.location===e.result.url&&(!e.result.stateKey||f.stateKey===e.result.stateKey)||f.controls.some(c=>c.href===e.result.url)));
  const assertions = relevant.flatMap(e => e.result.assertions || []);
  const outcomes = assertions.filter(a => ['pass', 'fail'].includes(a.outcome));
  if (!receipts.length || disposition === 'verified' && !outcomes.length) return {...fail('MODE_EXECUTION_REQUIRED', 'Execute host checks on the workflow feature or its observed link destination before verification. Inspect the expected locations below; unrelated page assertions cannot pass this workflow.'),expectedLocations:[...new Set(features.flatMap(f=>[f.location,...f.controls.map(c=>c.href).filter(Boolean)]))],observedLocations:[...new Set(receipts.map(r=>r.result.url).filter(Boolean))]};
  if (disposition !== 'verified' && (!reason?.trim() || !receipts.some(e => e.result.success === false || e.result.limitations?.length || e.result.gaps?.length))) return fail('MODE_BLOCKER_EVIDENCE_REQUIRED', 'A precise observed gap/tool failure is required; incomplete work is not a blocker.');
  w.status = disposition === 'verified' ? outcomes.some(a => a.outcome === 'fail')||relevant.some(e=>e.result.assertionCounts?.failed>0) ? 'failed' : 'passed' : disposition;
  w.evidenceIds = receipts.map(e => e.id); w.assertions = outcomes.length; w.reason = reason; w.completedAt = Date.now(); state.currentWorkflowId = null;
  w.verification={receipts:structuredClone(receipts)};
  w.verification.digest=hash([w.id,w.feature_ids,w.steps,w.expected_behavior,w.status,w.verification.receipts]);
  await checkpoint(); return { success: true, workflow: modeWorkflowSummary(w), coverage: modeWorkReadiness(session) };
 });
 const check = tool('mode_test_surface', 'Execute requested browser suites plus the active workflow’s declared SQA technical checks, then snapshot and diagnostics. Uses existing native templates; records actual assertions/gaps, never compliance or automatic workflow closure.', {
  checks: { type: 'array', minItems: 1, maxItems: 5, uniqueItems: true, items: { type: 'string', enum: ['accessibility', 'responsive', 'forms', 'search', 'media', 'anchors'] } }
 }, ['checks'], async ({ checks }, context = {}) => {
  if (!state.currentWorkflowId) return fail('MODE_WORKFLOW_REQUIRED', 'Start the relevant planned workflow first.');
  if(!Array.isArray(checks)||!checks.length||checks.length>5||checks.some(c=>!['accessibility','responsive','forms','search','media','anchors'].includes(c)))return fail('MODE_CHECK_INVALID','Choose 1–5 approved browser checks.');
  return owned(async () => {
   const results = [];
   const observed=await invoke('browser_qa_check',{action:'inspect'},context.signal);
   const controlIds=session.mode==='sqa'?state.workflows.find(w=>w.id===state.currentWorkflowId)?.control_ids||[]:[];
   if(controlIds.includes('SQA-WEB-002')){
    const inv=observed?.inventory;
    const link=inv?.links?.find(c=>c.selector&&safeUrl(c.href,session.targetUrl)&&c.href!==inv.url&&!new URL(c.href,inv.url).hash&&!c.target&&!c.download&&!RISKY.test(c.label||''));
    const control=inv?.navigationControls?.find(c=>c.selector&&!RISKY.test(c.label||''));
    const action=link?'navigation':control?'navigation_control':'anchors';
    results.push({action,...await invoke('browser_qa_check',link?{action,selector:link.selector,expected:link.href}:control?{action,selector:control.selector}:{action},context.signal)});
    const current=await invoke('browser_get_url',{},context.signal);
    if(inv?.url&&current.url!==inv.url)await invoke('browser_open',{url:inv.url},context.signal);
   }
   const mapped={'SQA-WEB-003':'forms','SQA-WEB-004':'accessibility','SQA-WEB-006':'responsive'};
   const planned=[...new Set([...checks,...controlIds.map(id=>mapped[id]).filter(Boolean)])];
   for (const action of planned) { context.signal?.throwIfAborted(); results.push({ action, ...await invoke('browser_qa_check', { action }, context.signal) }); }
   await invoke('browser_snapshot', {}, context.signal); await invoke('browser_diagnostics', {}, context.signal);
   return { success: true, results: results.map(r => ({ action: r.action, assertions: r.assertions?.length || 0, failed: r.assertions?.filter(a => a.outcome === 'fail').length || 0, gaps: r.gaps })) };
  });
 });
 const read=tool('mode_read_discovery','Read another bounded page of host-observed features without browsing or repeating discovery.',{offset:{type:'integer',minimum:0,maximum:160}},[],async({offset=0})=>{
  if(!Number.isSafeInteger(offset)||offset<0||offset>160)return fail('MODE_DISCOVERY_OFFSET','Choose a bounded feature offset.');
  const status=modeDiscoveryStatus(session);return {success:true,...status,featureCount:status.features.length,features:status.features.slice(offset,offset+20),nextOffset:offset+20<status.features.length?offset+20:null};
 });
 const recover=tool('mode_verify_recovery','After process interruption, inspect the new browser session before continuing the saved plan. Preserves evidence, completed workflows and cumulative usage. Never replays an uncertain action.',{},[],async(_input,context={})=>owned(async()=>{
  const current=await invoke('browser_get_url',{},context.signal);
  if(!current.url||current.url==='about:blank')await invoke('browser_open',{url:session.targetUrl},context.signal);
  const observed=await invoke('browser_qa_check',{action:'inspect'},context.signal);
  if(observed?.success===false||!observed?.inventory?.readiness?.ready)return fail('MODE_RECOVERY_BLOCKED','Fresh browser state could not be verified. Saved progress remains intact.');
  state.recoveryRequired=false;
  state.recoveries=[...(state.recoveries||[]),{at:Date.now(),url:observed.inventory.url,stateKey:observed.inventory.stateKey,evidenceId:observed.modeEvidenceId}].slice(-12);
  await checkpoint();return {success:true,recovery:state.recoveries.at(-1),work:modeWorkReadiness(session),message:'Use fresh observed controls to restore the active workflow; completed or uncertain mutations were not replayed.'};
 }));
 const batchNames=['browser_open','browser_snapshot','browser_get_url','browser_fill','browser_click','browser_key','browser_qa_check','browser_diagnostics'];
 const batch=tool('mode_execute_steps','Execute 1–8 ordered existing browser tools for the active workflow in one SDK turn. Prefer this for fill → click → snapshot sequences. Every child retains its original permission, budget, evidence and cancellation checks; stops on the first failed/uncertain outcome. No scripts or new authorization.',{
  steps:{type:'array',minItems:1,maxItems:8,items:{type:'object',additionalProperties:false,properties:{tool:{type:'string',enum:batchNames},input:{type:'object',additionalProperties:false,properties:{url:{type:'string'},selector:{type:'string'},value:{type:'string'},key:{type:'string'},action:{type:'string'},expected:{type:'string'}}}},required:['tool','input']}}
 },['steps'],async({steps},context={})=>{
  if(!state.currentWorkflowId)return fail('MODE_WORKFLOW_REQUIRED','Start the observed workflow first.');
  if(!Array.isArray(steps)||!steps.length||steps.length>8||steps.some(s=>!batchNames.includes(s.tool)||!s.input||typeof s.input!=='object'||Array.isArray(s.input)||Object.keys(s.input).some(k=>!['url','selector','value','key','action','expected'].includes(k))||JSON.stringify(s.input).length>3000||s.tool==='browser_qa_check'&&!['inspect','navigation','responsive','forms','search','media','disclosure','accessibility','anchors','tabs','scroll','navigation_control'].includes(s.input.action)))return fail('MODE_STEPS_INVALID','Use 1–8 supported browser steps with bounded native inputs.');
  return owned(async()=>{
   const results=[];
   for(const step of steps){context.signal?.throwIfAborted();const result=await invoke(step.tool,step.input,context.signal);results.push({tool:step.tool,success:result?.success!==false,modeEvidenceId:result?.modeEvidenceId,evidenceActivityId:result?.evidenceActivityId,url:result?.url||result?.inventory?.url,assertions:result?.assertions?.length});if(result?.success===false)return {success:false,results,error:result.error||'A child browser step failed; later steps were not executed.'};}
   return {success:true,results};
  });
 });
 const optional=['browser_snapshot','browser_get_url','browser_open','browser_fill','browser_click','browser_hover','browser_scroll','browser_check','browser_select','browser_media','browser_test_meeting_link','browser_wait','browser_dialog','browser_screenshot','browser_tabs','browser_new_tab','browser_select_tab','browser_close_tab','browser_type','browser_key'];
 const runWorkflow=tool('mode_run_workflow','PREFERRED: validate and activate ONE pending observed workflow, optionally navigate to its observed URL, execute bounded ordered steps and native check suites, then derive its verified outcome from actual host assertions. One SDK call avoids separate paid start/check/close calls. Stops on failure; never replays completed/uncertain work or supplies missing assertions.',{
  id:{type:'string'},url:{type:'string'},checks:check.parametersSchema.properties.checks,steps:batch.parametersSchema.properties.steps
 },['id','checks'],async(input,context={})=>{
  if(!Array.isArray(input.checks)||!input.checks.length||input.checks.length>5||input.checks.some(c=>!check.parametersSchema.properties.checks.items.enum.includes(c)))return fail('MODE_CHECK_INVALID','Choose 1–5 approved browser checks.');
  const w=state.workflows?.find(w=>w.id===input.id);
  const features=modeDiscoveryStatus(session).features.filter(f=>w?.feature_ids.includes(f.id));
  if(input.url&&!features.some(f=>f.location===input.url||f.controls.some(c=>c.href===input.url)))return fail('MODE_WORKFLOW_LOCATION','Use only this workflow’s observed feature URL or its observed link destination.');
  const activated=await start.run({id:input.id},context);if(!activated.success)return activated;
  context.signal?.throwIfAborted();
  if(input.url){const current=await owned(()=>invoke('browser_get_url',{},context.signal));if(current.url!==input.url){const opened=await batch.run({steps:[{tool:'browser_open',input:{url:input.url}}]},context);if(!opened.success)return opened;}}
  if(input.steps){const executed=await batch.run({steps:input.steps},context);if(!executed.success)return executed;}
  const checked=await check.run({checks:input.checks},context);if(!checked.success)return checked;
  context.signal?.throwIfAborted();return close.run({id:input.id,disposition:'verified'},context);
 });
 const load=tool('mode_load_tools','Expose up to five additional already-approved browser tools when a discovered workflow needs them. Replaces the optional set; never grants new permissions. Prefer ordered mode_execute_steps and mode_test_surface for ordinary checks.',{names:{type:'array',minItems:1,maxItems:5,uniqueItems:true,items:{type:'string',enum:optional}}},['names'],async({names})=>{
  if(!Array.isArray(names)||!names.length||names.length>5||names.some(n=>!optional.includes(n)||!toolNames().includes(n)))return fail('MODE_TOOL_UNAVAILABLE','Choose only registered browser capabilities from the documented optional set.');
  state.loadedModeTools=[...new Set(names)];await checkpoint();return {success:true,tools:state.loadedModeTools};
 });
 return { internal, observe, refusal, tools: [discover, read, plan, runWorkflow,start, close, check, batch, recover, load] };
}
