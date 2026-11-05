import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createQaScenarioLedger } from './qaScenarioLedger.js';
import { applicationDiscoveryStatus, observeApplication, bindDiscoveredPlan } from './qaApplicationDiscovery.js';
import { featureStateKey } from './qaFeatureState.js';
import { recordInferenceProgress } from './qaInferenceProgress.js';
import {createHybridRuntime} from './hybridQaRuntime.js';
import {hybridProfile} from './hybridConfig.js';

function fixture() {
  const session = { id: randomUUID(), mode: 'qa', targetUrl: 'https://fixture.test/', selectedTests: ['navigation', 'search'],
    hybrid: { discovery: { version: 1, status: 'pending', features: [], observations: [], probes: [] } } };
  return { session, ledger: createQaScenarioLedger(session) };
}

test('discovery-first runs cannot plan or execute from an unsupported claim of discovery', async () => {
  const { session, ledger } = fixture();
  const scenario = ledger.state.scenarios[0];
  await assert.rejects(ledger.plan([{ id: scenario.id, category: scenario.category, objective: 'Generic page sample', expected: { source: 'hypothesis', text: 'Looks correct' } }]), /discovery/i);
  await assert.rejects(ledger.start(scenario.id), /discovery/i);
  session.hybrid.discovery.status = 'ready';
  session.hybrid.discovery.features.push({ id: 'invented', evidenceRefs: ['not-real'], location: session.targetUrl });
  await assert.rejects(ledger.start(scenario.id), /discovery/i);
});

test('a discovery-first greeting without a target does not schedule undefined browser navigation',async()=>{
 const session={id:randomUUID(),mode:'qa',qaExecutionMode:'hybrid',qaDiscoveryVersion:1,messages:[],findings:[],selectedTests:['navigation']};
 const runtime=createHybridRuntime({session,record:{},profile:hybridProfile({apiKey:'fixture'},{}),runStore:{async commit(){}}});
 const service={async chat(_messages,options){runtime.usage({reservationId:options.qaseBudgetReservationId,callId:randomUUID(),inputTokens:10,outputTokens:5,estimated:false});return(async function*(){yield{type:'text',content:'Please provide the target URL.'};})();}};
 runtime.wrapChat(service);const parts=[];for await(const p of await service.chat([],{tools:runtime.tools}))parts.push(p);
 assert.equal(parts[0].type,'text');assert.equal(session.hybrid.scheduler.hostDispatches,undefined);assert.equal(session.hybrid.actions.length,0);
});

async function inventory(f, data = {}) {
  const value = {url:f.session.targetUrl,title:'Workspace',headings:['Workspace'],links:[],navigationControls:[],readiness:{ready:true},...data};
  value.stateKey=featureStateKey(value);
  const a=await f.ledger.beginAction('browser_qa_check',{action:'inspect'});
  return f.ledger.record(a,{success:true,url:value.url,inventory:value});
}

test('valid discovery preserves requested missing scope, and plan additions require observed features',async()=>{
 const f=fixture();await inventory(f);const d=f.session.hybrid.discovery;d.status='ready';d.completedAccess='public';d.proofEvidenceIds=d.observations.map(o=>o.evidenceId);
 assert.equal(applicationDiscoveryStatus(f.session).ready,true);bindDiscoveredPlan(f.session);
 assert.equal(f.ledger.state.scenarios.length,2);assert.equal(f.ledger.state.scenarios[1].discoveryPlan.applicability,'not_yet_observed');
 await assert.rejects(f.ledger.plan([{category:'navigation',objective:'Invented checkout workflow',expected:{source:'hypothesis',text:'Works'}}]),/observed feature_ids/);
 const feature=applicationDiscoveryStatus(f.session).features[0];
 await f.ledger.plan([{category:'navigation',objective:'Verify this observed surface',expected:{source:'hypothesis',text:'Host assertions'},feature_ids:[feature.id]}]);
 assert.deepEqual(f.ledger.state.scenarios.at(-1).discoveryPlan.featureIds,[feature.id]);
 assert.equal(f.ledger.state.scenarios.every(s=>s.assertions.length===0),true);
});

test('tampering, wrong run and a new access context invalidate discovery before execution',async()=>{
 const f=fixture(),e=await inventory(f),d=f.session.hybrid.discovery;d.status='ready';d.completedAccess='public';d.proofEvidenceIds=d.observations.map(o=>o.evidenceId);
 assert.equal(applicationDiscoveryStatus(f.session).ready,true);
 e.result.inventory.title='Modified';assert.equal(applicationDiscoveryStatus(f.session).ready,false);
 const g=fixture(),fresh=await inventory(g);g.session.hybrid.discovery.status='ready';g.session.hybrid.discovery.completedAccess='public';g.session.hybrid.discovery.proofEvidenceIds=g.session.hybrid.discovery.observations.map(o=>o.evidenceId);fresh.runId='another-run';
 assert.equal(applicationDiscoveryStatus(g.session).ready,false);
 const h=fixture();await inventory(h);h.session.hybrid.discovery.status='ready';h.session.hybrid.discovery.completedAccess='public';h.session.hybrid.discovery.proofEvidenceIds=h.session.hybrid.discovery.observations.map(o=>o.evidenceId);
 h.session.hybrid.authentication={status:'access_observed',grantId:'approved-scope'};
 assert.equal(applicationDiscoveryStatus(h.session).ready,false);
});

test('ready labels and repeated inventories cannot replace bounded navigation probes',async()=>{
 const f=fixture(),e=await inventory(f,{navigationControls:[{selector:'#projects',label:'Projects'},{selector:'#reports',label:'Reports'}]});
 const d=f.session.hybrid.discovery;d.status='ready';d.completedAccess='public';d.proofEvidenceIds=d.observations.map(o=>o.evidenceId);
 observeApplication(f.session,e);assert.equal(d.observations.length,1);
 assert.equal(applicationDiscoveryStatus(f.session).ready,false);
 const snapshot=JSON.parse(JSON.stringify(f.session));assert.equal(applicationDiscoveryStatus(snapshot).ready,false);
});

test('a loading shell cannot certify discovery even when serialized metadata says ready',async()=>{
 const f=fixture();await inventory(f,{readiness:{ready:false,reason:'loading_shell'}});
 const d=f.session.hybrid.discovery;d.status='ready';d.completedAccess='public';d.proofEvidenceIds=d.observations.map(o=>o.evidenceId);d.observations[0].ready=true;
 assert.equal(applicationDiscoveryStatus(f.session).ready,false);
});

test('continuous discovery adds features without relocking an active validated scenario',async()=>{
 const f=fixture();await inventory(f);const d=f.session.hybrid.discovery;d.status='ready';d.completedAccess='public';d.proofEvidenceIds=d.observations.map(o=>o.evidenceId);bindDiscoveredPlan(f.session);
 await f.ledger.start(f.ledger.state.scenarios[0].id);
 await inventory(f,{navigationControls:[{selector:'#new-feature',label:'Reports'}]});
 assert.equal(applicationDiscoveryStatus(f.session).ready,true);
 assert.ok(applicationDiscoveryStatus(f.session).features.some(f=>f.name==='Reports'));
 assert.equal(f.ledger.state.scenarios[0].status,'running');
});

test('model-turn stalls are bounded within one SDK segment; repeated text and inspection are not progress',async()=>{
 const f=fixture();await inventory(f);
 const state=f.session.hybrid;state.exploration={routes:[]};
 assert.equal(recordInferenceProgress(state).stalled,false);
 for(let i=0;i<7;i++){await inventory(f);state.scenarios[0].uncertainty.push('Repeat explanation');assert.equal(recordInferenceProgress(state).stalled,false);}
 assert.equal(recordInferenceProgress(state).stalled,true);
 await inventory(f,{headings:['Reports']});assert.equal(recordInferenceProgress(state).stalled,false);
 const copy=JSON.parse(JSON.stringify(state));assert.equal(recordInferenceProgress(copy).stagnantTurns,1,'Checkpoint recovery retains the counter.');
});
