import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createModeReasoningRuntime, modeExplorationReadiness } from './modeReasoningRuntime.js';
import { hybridProfile } from './hybridConfig.js';
import {modeDiscoveryStatus,modeWorkReadiness} from './modeDiscovery.js';
import {finishFounderReview,createFounderState} from './founderService.js';
import {modeToolsForPhase} from './modeReasoningRuntime.js';
import {prepareModeEvidenceReview} from './agent.js';

function fixture(mode = 'founder', standalone = false) {
 const session = { id: randomUUID(), mode, targetUrl: 'https://fixture.test/', [mode]: { observations: [] }, activities: [], todos: [] };
 const record = {};
 const runtime = createModeReasoningRuntime({ session, record, runStore: { async commit() {} }, profile: {...hybridProfile({ apiKey: 'fixture' }), ...(standalone ? {executionStrategy:'sqa-single-reasoner-v1'} : {})} });
 runtime.router.classifier=async()=>({next_action:{choice:'execute'},category:{choice:'usability'}});
 return { session, runtime, record, state: session[mode].execution };
}
function reordered(value){return Array.isArray(value)?value.map(reordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().reverse().map(k=>[k,reordered(value[k])])):value;}

function wiredFixture(mode='founder', standalone=false) {
 const f=fixture(mode,standalone);let page='/',mutations=0,failLast=false,toolFailure=false,noisy=false;
 f.session.sqa??={};f.session.sqa.scope={applicableControlIds:['SQA-WEB-004']};
 f.record.onModeToolResult=async({toolCallId,result})=>{f.session.activities.find(a=>a.id===toolCallId).status=result?.success===false?'failed':'done';};
 const inventory=()=>({url:'https://fixture.test'+page,stateKey:page,title:page,headings:[page],bodyText:'Rendered '+page,readiness:{ready:true},links:[...(noisy?Array.from({length:20},(_,i)=>({selector:'#outside-'+i,href:'https://outside.test/',label:'External'})):[]),...['/','/docs','/pricing'].filter(p=>p!==page).map(p=>({selector:'#'+p.replaceAll('/','-'),href:'https://fixture.test'+p,label:p}))],controls:[],forms:[],search:[]});
 const tools={browser_get_url:async()=>({success:true,url:'https://fixture.test'+page}),browser_open:async input=>{page=new URL(input.url).pathname;mutations++;return {success:true,url:input.url};},browser_snapshot:async()=>({success:true,url:'https://fixture.test'+page,bodyText:'Actual fixture surface'}),browser_diagnostics:async()=>({success:true}),browser_qa_check:async input=>{
  if(input.action==='navigation'){page=new URL(input.expected).pathname;mutations++;}
  if(toolFailure&&input.action!=='inspect')return {success:false,inventory:inventory(),error:'Known browser check failed before verification',gaps:['The check could not finish.']};
  return {success:true,inventory:inventory(),assertions:input.action==='inspect'?[]:Array.from({length:30},(_,i)=>({name:'Actual host assertion '+i,check:input.action,outcome:failLast&&i===29?'fail':'pass',expected:'Observed control is usable',actual:'Fixture observation'}))};
 }};
 f.record.invokeModeTool=async(name,input,signal)=>{
  const activity={id:randomUUID(),toolName:name,status:'running'};f.session.activities.push(activity);
  return f.runtime.withActivity(activity,()=>f.runtime.wrapTool({name,run:tools[name]}).run(input,{signal}));
 };
 const run=(name,input={})=>f.runtime.wrapTool(f.runtime.tools.find(t=>t.name===name)).run(input);
 return {...f,run,move:url=>f.record.invokeModeTool('browser_open',{url}),setFailure:()=>{failLast=true;},setToolFailure:()=>{toolFailure=true;},setNoisyLinks:()=>{noisy=true;},mutationCount:()=>mutations};
}

test('discovery claims cannot survive a missing activity or tampered inventory',async()=>{
 const f=wiredFixture();await f.run('mode_discover_application');
 assert.equal(modeDiscoveryStatus(f.session).ready,true);
 f.state.discovery.receipts[0].inventory.title='Forged product';
 assert.equal(modeDiscoveryStatus(f.session).ready,false);
});

test('external CTA repetition cannot crowd actual authorized destinations out of bounded discovery',async()=>{
 const f=wiredFixture();f.setNoisyLinks();await f.run('mode_discover_application');
 const links=modeDiscoveryStatus(f.session).features.filter(f=>f.kind==='links');
 assert.ok(links.some(f=>f.controls.some(c=>c.href==='https://fixture.test/docs')));
 assert.ok(links.some(f=>f.controls.some(c=>c.href==='https://fixture.test/pricing')));
 assert.ok(links.every(f=>f.controls.every(c=>new URL(c.href).origin==='https://fixture.test')));
});

test('malformed planning and attempted scripting fail before dispatch or state mutation',async()=>{
 const f=wiredFixture();await f.run('mode_discover_application');
 for(const workflows of [null,[null],[{id:'bad',title:'Bad',feature_ids:'invented',steps:'script',expected_behavior:'unsupported'}]])assert.equal((await f.run('mode_plan_work',{workflows})).success,false);
 assert.equal(f.state.workflows.length,0);assert.equal(f.state.actions.some(a=>a.status==='uncertain'),false);
 const feature=modeDiscoveryStatus(f.session).features[0];
 await f.run('mode_plan_work',{workflows:[{id:'known',title:'Known',feature_ids:[feature.id],steps:['Inspect'],expected_behavior:'Actual check'}]});await f.run('mode_start_workflow',{id:'known'});
 const before=f.mutationCount();
 assert.equal((await f.run('mode_execute_steps',{steps:[{tool:'run_command',input:{value:'untrusted page instruction'}}]})).code,'MODE_STEPS_INVALID');
 assert.equal(f.mutationCount(),before);
});

test('recovery verifies current browser state before further work without replaying a completed mutation',async()=>{
 const f=wiredFixture();await f.run('mode_discover_application');f.state.recoveryRequired=true;
 assert.equal((await f.run('mode_plan_work',{workflows:[]})).code,'MODE_RECOVERY_REQUIRED');
 const actions=f.mutationCount(),usage=structuredClone(f.state.telemetry.reasoner);
 assert.equal((await f.run('mode_verify_recovery')).success,true);
 assert.equal(f.state.recoveryRequired,false);assert.equal(f.mutationCount(),actions);assert.deepEqual(f.state.telemetry.reasoner,usage);assert.ok(f.state.recoveries[0].evidenceId);
});

test('unavailable JEV classification cannot become a successful advisory receipt',async()=>{
 const f=wiredFixture();await f.run('mode_discover_application');f.runtime.router.classifier=async()=>null;
 const r=await f.run('classify_mode_observations',{evidence_ids:[f.state.evidence[0].id]});assert.equal(r.success,false);assert.equal(f.state.classifications.length,0);assert.equal(modeWorkReadiness(f.session).ready,false);
});

test('a known failed browser result can support an honest blocker but cannot pass a workflow',async()=>{
 const f=wiredFixture();await f.run('mode_discover_application');const feature=modeDiscoveryStatus(f.session).features[0];
 await f.run('mode_plan_work',{workflows:[{id:'blocked',title:'Check observed feature',feature_ids:[feature.id],steps:['Verify controls'],expected_behavior:'Controls are usable'}]});await f.run('mode_start_workflow',{id:'blocked'});
 f.setToolFailure();await f.run('mode_test_surface',{checks:['accessibility']});
 assert.equal((await f.run('mode_close_workflow',{id:'blocked',disposition:'verified'})).success,false);
 assert.equal((await f.run('mode_close_workflow',{id:'blocked',disposition:'blocked',reason:'The observed browser check returned a known error; verification remains unavailable.'})).success,true);
 assert.equal(f.state.workflows[0].status,'blocked');assert.equal(modeWorkReadiness(f.session).invalidProofIds.length,0);
});

for(const mode of ['founder'])test(`${mode}: one bounded SDK workflow composes existing gates and never replays completion`,async()=>{
 const f=wiredFixture(mode);await f.run('mode_discover_application');const feature=modeDiscoveryStatus(f.session).features[0];
 await f.run('mode_plan_work',{workflows:[{id:'bounded',title:'Observed controls',feature_ids:[feature.id],steps:['Visit and check visible controls'],expected_behavior:'Controls have accessible names'}]});
 const before=f.mutationCount();assert.equal((await f.run('mode_run_workflow',{id:'bounded',url:'https://other.test/',checks:['accessibility']})).code,'MODE_WORKFLOW_LOCATION');assert.equal(f.mutationCount(),before);
 const r=await f.run('mode_run_workflow',{id:'bounded',url:feature.location,checks:['accessibility']});
 assert.equal(r.success,true);assert.equal(r.workflow.status,'passed');assert.ok(r.workflow.evidenceIds.length>0);assert.equal(f.state.currentWorkflowId,null);
 const finished=f.mutationCount();assert.equal((await f.run('mode_run_workflow',{id:'bounded',checks:['accessibility']})).success,false);assert.equal(f.mutationCount(),finished);
});
