import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createModeReasoningRuntime, modeExplorationReadiness } from './modeReasoningRuntime.js';
import { hybridProfile } from './hybridConfig.js';
import {modeDiscoveryStatus,modeWorkReadiness,modeSqaEvidenceActivityIds} from './modeDiscovery.js';
import {finishSqaAssessment,createSqaState,recordAgentSqaObservation} from './sqaService.js';
import {finishFounderReview,createFounderState} from './founderService.js';
import {modeToolsForPhase} from './modeReasoningRuntime.js';
import {prepareModeEvidenceReview} from './agent.js';
import {inspectSqaEvidence} from './sqaEvidence.js';

function fixture(mode = 'sqa', standalone = false) {
 const session = { id: randomUUID(), mode, targetUrl: 'https://fixture.test/', [mode]: { observations: [] }, activities: [], todos: [] };
 const record = {};
 const runtime = createModeReasoningRuntime({ session, record, runStore: { async commit() {} }, profile: {...hybridProfile({ apiKey: 'fixture' }), ...(standalone ? {executionStrategy:'sqa-single-reasoner-v1'} : {})} });
 runtime.router.classifier=async()=>({next_action:{choice:'execute'},category:{choice:'usability'}});
 return { session, runtime, record, state: session[mode].execution };
}
function reordered(value){return Array.isArray(value)?value.map(reordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().reverse().map(k=>[k,reordered(value[k])])):value;}

function wiredFixture(mode='sqa', standalone=false) {
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

for(const mode of ['sqa','founder'])test(`${mode}: durable discovery, scoped plans, actual assertions and integrity determine completion`,async t=>{
 const f=wiredFixture(mode);
 assert.equal((await f.run('mode_discover_application')).success,true);
 const discovery=modeDiscoveryStatus(f.session);assert.equal(discovery.ready,true);assert.ok(discovery.features.length>2);
 const count=f.mutationCount();await f.run('mode_discover_application');assert.equal(f.mutationCount(),count,'Continuation reuses discovery.');
 assert.equal((await f.run('mode_plan_work',{workflows:[{id:'invented',title:'Invented',feature_ids:['forged'],steps:['Invented'],expected_behavior:'Invented'}]})).success,false);
 const features=discovery.features.filter(f=>f.kind==='surface').slice(0,2);
 assert.equal((await f.run('mode_plan_work',{workflows:features.map((feature,i)=>({id:'w'+i,title:'Review '+feature.name,feature_ids:[feature.id],steps:['Run actual check'],expected_behavior:'Observed controls remain usable',control_ids:mode==='sqa'?['SQA-WEB-004']:undefined}))})).success,true);
 assert.equal(modeWorkReadiness(f.session).ready,false);
 for(const [i,feature]of features.entries()){
  assert.equal((await f.run('mode_start_workflow',{id:'w'+i})).success,true);
  assert.equal((await f.run('mode_close_workflow',{id:'w'+i,disposition:'verified'})).code,'MODE_EXECUTION_REQUIRED');
  await f.move(feature.location);if(i===1)f.setFailure();
  await f.run('mode_test_surface',{checks:['accessibility']});
  const closed=await f.run('mode_close_workflow',{id:'w'+i,disposition:'verified'});
  assert.equal(closed.success,true);assert.equal(closed.workflow.status,i===1?'failed':'passed','A failure after the first 25 assertions cannot disappear through compaction.');
  assert.equal((await f.run('mode_start_workflow',{id:'w'+i})).success,false,'Completed work cannot replay.');
 }
 f.runtime.router.classifier=async()=>({category:{choice:'usability'}});
 await f.run('classify_mode_observations',{evidence_ids:[f.state.evidence.find(e=>e.tool==='browser_qa_check').id]});
 assert.equal(modeWorkReadiness(f.session).ready,true);
 assert.equal(modeWorkReadiness(reordered(f.session)).ready,true,'JSONB object-key order must not invalidate an otherwise identical checkpoint.');
 await t.test('PostgreSQL JSONB checkpoint round-trip',{skip:!process.env.QASE_TEST_DATABASE_URL},async()=>{
  const {Client}=await import('pg');const client=new Client({connectionString:process.env.QASE_TEST_DATABASE_URL});await client.connect();
  try{const{rows}=await client.query('SELECT $1::jsonb AS checkpoint',[JSON.stringify(f.session)]);assert.equal(modeWorkReadiness(rows[0].checkpoint).ready,true);}finally{await client.end();}
 });
 let cleared=0;f.record.modeReasoning=f.runtime;f.record.runtime={clearConversation(){cleared++;}};
 const actions=f.mutationCount(),usage=structuredClone(f.state.telemetry);
 assert.equal(prepareModeEvidenceReview(f.session,f.record),true);assert.equal(cleared,1);assert.equal(f.state.phase,'evidence_review');assert.equal(f.mutationCount(),actions);assert.deepEqual(f.state.telemetry,usage);
 assert.equal(prepareModeEvidenceReview(f.session,f.record),false,'A completed workflow cannot cause repeated context handoffs.');
 if(mode==='sqa')assert.ok(modeSqaEvidenceActivityIds(f.session,'SQA-WEB-004').size>0);
 const saved=structuredClone(f.session);
 const restored=createModeReasoningRuntime({session:saved,runStore:{async commit(){}},record:{},profile:hybridProfile({apiKey:'fixture'})});
 assert.deepEqual(restored.state.budgets,f.state.budgets);assert.equal(modeWorkReadiness(saved).ready,true);
 f.state.evidence=[];assert.equal(modeWorkReadiness(f.session).ready,true,'Pinned workflow receipts outlive rolling context summaries.');
 f.state.workflows[0].verification.receipts[0].result.success=false;
 assert.equal(modeWorkReadiness(f.session).ready,false,'Corrupted verification cannot authorize publication.');
});

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

test('every service publication entry point enforces the new mode contract',async()=>{
 const s=fixture('sqa').session;s.sqa={...createSqaState({authorizationConfirmed:true,profiles:['core'],attributes:['web_application'],target:{name:'Fixture',release:'test',environment:'test'}}),execution:s.sqa.execution};
 await assert.rejects(finishSqaAssessment(s,{async commit(){throw new Error('Must not publish');}}),/publication requires/);
 const f=fixture('founder').session;f.founder={...createFounderState({authorizationConfirmed:true,target:{name:'Fixture',url:f.targetUrl}}),execution:f.founder.execution};
 await assert.rejects(finishFounderReview(f,{},{}),/publication requires/);
 assert.equal(s.sqa.finalizedAt,undefined);assert.equal(f.founder.finalizedAt,undefined);
});

test('phase-specific schemas prevent repeated planning payloads and report synthesis before execution',async()=>{
 const f=wiredFixture(),all=['mode_discover_application','mode_plan_work','mode_execute_steps','finish_sqa_assessment','record_sqa_control','browser_fill'].map(name=>({name}));
 assert.deepEqual(modeToolsForPhase(f.session,all).map(t=>t.name),['mode_discover_application']);
 await f.run('mode_discover_application');assert.deepEqual(modeToolsForPhase(f.session,all).map(t=>t.name),['mode_plan_work']);
 const feature=modeDiscoveryStatus(f.session).features[0];await f.run('mode_plan_work',{workflows:[{id:'known',title:'Known',feature_ids:[feature.id],steps:['Inspect'],expected_behavior:'Actual check'}]});
 assert.equal(modeToolsForPhase(f.session,all).some(t=>['finish_sqa_assessment','record_sqa_control','browser_fill'].includes(t.name)),false);
});

test('unavailable JEV classification cannot become a successful advisory receipt',async()=>{
 const f=wiredFixture();await f.run('mode_discover_application');f.runtime.router.classifier=async()=>null;
 const r=await f.run('classify_mode_observations',{evidence_ids:[f.state.evidence[0].id]});assert.equal(r.success,false);assert.equal(f.state.classifications.length,0);assert.equal(modeWorkReadiness(f.session).ready,false);
});

test('verified observed link destinations count as distinct planned surfaces and typed technical evidence needs no model tag',async()=>{
 const f=wiredFixture();await f.run('mode_discover_application');
 const links=modeDiscoveryStatus(f.session).features.filter(feature=>feature.kind==='links'&&feature.location===f.session.targetUrl).slice(0,2);
 assert.equal(links.length,2);
 await f.run('mode_plan_work',{workflows:links.map((feature,i)=>({id:'destination-'+i,title:'Verify observed '+feature.name,feature_ids:[feature.id],steps:['Visit observed destination and check controls'],expected_behavior:'Destination controls remain accessible'}))});
 for(const [i,feature]of links.entries()){
  await f.run('mode_start_workflow',{id:'destination-'+i});await f.move(feature.controls[0].href);
  await f.run('mode_test_surface',{checks:['accessibility']});
  assert.equal((await f.run('mode_close_workflow',{id:'destination-'+i,disposition:'verified'})).success,true);
 }
 f.runtime.router.classifier=async()=>({category:{choice:'usability'}});
 await f.run('classify_mode_observations',{evidence_ids:[f.state.evidence.find(e=>e.tool==='browser_qa_check').id]});
 assert.equal(modeWorkReadiness(f.session).ready,true,'The origin of a discovered link cannot hide its actually verified destination.');
 assert.ok(modeSqaEvidenceActivityIds(f.session,'SQA-WEB-004').size>0,'Typed checks determine technical evidence, not a model label.');
 assert.equal(modeSqaEvidenceActivityIds(f.session,'SQA-SEC-001').size,0,'Broader assurance claims still require a relevant explicitly tagged workflow.');
});

test('a known failed browser result can support an honest blocker but cannot pass a workflow',async()=>{
 const f=wiredFixture();await f.run('mode_discover_application');const feature=modeDiscoveryStatus(f.session).features[0];
 await f.run('mode_plan_work',{workflows:[{id:'blocked',title:'Check observed feature',feature_ids:[feature.id],steps:['Verify controls'],expected_behavior:'Controls are usable'}]});await f.run('mode_start_workflow',{id:'blocked'});
 f.setToolFailure();await f.run('mode_test_surface',{checks:['accessibility']});
 assert.equal((await f.run('mode_close_workflow',{id:'blocked',disposition:'verified'})).success,false);
 assert.equal((await f.run('mode_close_workflow',{id:'blocked',disposition:'blocked',reason:'The observed browser check returned a known error; verification remains unavailable.'})).success,true);
 assert.equal(f.state.workflows[0].status,'blocked');assert.equal(modeWorkReadiness(f.session).invalidProofIds.length,0);
});

test('a model-proposed technical SQA pass cannot override an actual matching failed host assertion',async()=>{
 const f=wiredFixture();f.session.sqa={...createSqaState({authorizationConfirmed:true,profiles:['core'],attributes:['web_application','user_interface'],target:{name:'Fixture',release:'test',environment:'isolated'}}),execution:f.state};
 await f.run('mode_discover_application');const feature=modeDiscoveryStatus(f.session).features[0];
 await f.run('mode_plan_work',{workflows:[{id:'a11y',title:'Verify accessible controls',feature_ids:[feature.id],steps:['Check accessible names'],expected_behavior:'Controls have accessible names'}]});await f.run('mode_start_workflow',{id:'a11y'});
 f.setFailure();await f.move(feature.location);await f.run('mode_test_surface',{checks:['accessibility']});
 const input={control_id:'SQA-WEB-004',status:'pass',evidence:[{type:'wcag_report',summary:'Observed semantic assertion sample.'}]};
 await assert.rejects(recordAgentSqaObservation(f.session,input,{async commit(){}}),/contradicts its failed matching host assertions/);
 assert.equal(f.session.sqa.observations.length,0);
 await recordAgentSqaObservation(f.session,{...input,status:'fail',rationale:'A host assertion actually failed; this is a scoped sample.'},{async commit(){}});
 assert.equal(f.session.sqa.observations[0].status,'fail');
 const inspected=inspectSqaEvidence(f.session,'SQA-WEB-004',1);
 assert.equal(inspected.integrity,'verified','Discovery-bound evidence must retain the inspectable digest bundle.');
 const allowed=modeSqaEvidenceActivityIds(f.session,'SQA-WEB-004');
 assert.ok(inspected.activities.length>0);
 assert.ok(inspected.activities.every(activity=>allowed.has(activity.id)),'The retained bundle must contain only matching control checks.');
});

for(const mode of ['sqa','founder'])test(`${mode}: one bounded SDK workflow composes existing gates and never replays completion`,async()=>{
 const f=wiredFixture(mode);await f.run('mode_discover_application');const feature=modeDiscoveryStatus(f.session).features[0];
 await f.run('mode_plan_work',{workflows:[{id:'bounded',title:'Observed controls',feature_ids:[feature.id],steps:['Visit and check visible controls'],expected_behavior:'Controls have accessible names'}]});
 const before=f.mutationCount();assert.equal((await f.run('mode_run_workflow',{id:'bounded',url:'https://other.test/',checks:['accessibility']})).code,'MODE_WORKFLOW_LOCATION');assert.equal(f.mutationCount(),before);
 const r=await f.run('mode_run_workflow',{id:'bounded',url:feature.location,checks:['accessibility']});
 assert.equal(r.success,true);assert.equal(r.workflow.status,'passed');assert.ok(r.workflow.evidenceIds.length>0);assert.equal(f.state.currentWorkflowId,null);
 const finished=f.mutationCount();assert.equal((await f.run('mode_run_workflow',{id:'bounded',checks:['accessibility']})).success,false);assert.equal(f.mutationCount(),finished);
});

test('finishing the current plan with missing page coverage enters an actionable host recovery phase, not report closeout',async()=>{
 const f=wiredFixture();await f.run('mode_discover_application');const feature=modeDiscoveryStatus(f.session).features.find(f=>f.kind==='links');
 await f.run('mode_plan_work',{workflows:[{id:'observed',title:'Observed surface',feature_ids:[feature.id],steps:['Verify observed controls'],expected_behavior:'Accessible controls'}]});
 await f.run('mode_run_workflow',{id:'observed',url:feature.controls[0].href,checks:['accessibility']});
 f.runtime.router.classifier=async()=>({category:{choice:'usability'}});await f.run('classify_mode_observations',{evidence_ids:[f.state.evidence.find(e=>e.tool==='browser_qa_check').id]});
 for(let n=0;n<8;n++)f.state.routes.push({url:`https://fixture.test/observed-${n}`,reviewed:false});
 f.record.modeReasoning=f.runtime;f.record.runtime={clearConversation(){}};
 assert.equal(prepareModeEvidenceReview(f.session,f.record),true);assert.equal(f.state.phase,'coverage_recovery');
 assert.equal(modeExplorationReadiness(f.session).ready,false);
 const advertised=modeToolsForPhase(f.session,['mode_plan_work','mode_execution_progress','record_sqa_control','finish_sqa_assessment'].map(name=>({name}))).map(t=>t.name);
 assert.deepEqual(advertised,['mode_plan_work','mode_execution_progress']);
 assert.ok((await f.run('mode_execution_progress')).exploration.nextRoutes.length>0);
 let asked=0;const ask=f.runtime.wrapTool({name:'ask_question',async run(){asked++;return {success:true};}});
 const internal=await ask.run({question:'Browser tools are not exposed; should the host retry or publish now?'});
 assert.equal(internal.code,'MODE_HOST_CONTINUATION_REQUIRED');assert.equal(asked,0);assert.ok(internal.exploration.nextRoutes.length);
 await ask.run({question:'A test account is required for this requested private workflow.'});assert.equal(asked,1,'Genuine missing access is still a user boundary.');
 // Unit fixture supplies actual-route coverage separately; this never marks
 // scenarios or controls passed, and production obtains it from browser calls.
 f.state.routes.forEach(r=>r.reviewed=true);
 assert.equal(prepareModeEvidenceReview(f.session,f.record),true);assert.equal(f.state.phase,'evidence_review');
 assert.equal(prepareModeEvidenceReview(f.session,f.record),false);
});

for (const mode of ['sqa', 'founder']) {
 test(`${mode}: planning cannot precede host-verified discovery`, async () => {
  const f = fixture(mode); let dispatched = false;
  const result = await f.runtime.wrapTool({ name: 'update_todo', async run() { dispatched = true; return { success: true }; } }).run({ todos: [] });
  assert.equal(dispatched, false);
  assert.equal(result.code, 'MODE_DISCOVERY_REQUIRED');
 });
 test(`${mode}: page counts and model-authored plan completion cannot qualify publication`, () => {
  const f = fixture(mode);
  f.state.routes = [{ url: f.session.targetUrl, reviewed: true }];
  f.state.actions.push({ status: 'done', interaction: true, tool: 'browser_click' }, { status: 'done', tool: 'browser_diagnostics' });
  assert.equal(modeExplorationReadiness(f.session).ready, false);
 });
}

test('a restored standalone plan yields an exportable scoped snapshot and altered evidence blocks it', async()=>{
 const {createSqaResearch,standaloneResearchReadiness}=await import('./sqaResearch.js');
 const {researchMarkdown}=await import('../public/sqaResearchSections.js');
 const {createHash}=await import('node:crypto');
 const f=wiredFixture('sqa',true);
 await f.run('mode_discover_application');
 const shortlink='https://www.w3.org/TR/Fixture-2/',api='https://api.w3.org/specifications/Fixture-2';
 const edition=api+'/versions/20240101';
 const content='Fixture Standard. abstract. F1. Visible control names should be discoverable.';
 const responses=new Map([[shortlink,content],[api,JSON.stringify({shortname:'Fixture-2',shortlink,title:'Fixture Standard','series-version':'2',_links:{'latest-version':{href:edition}}})],
  [edition,JSON.stringify({shortlink,title:'Fixture Standard',uri:'https://www.w3.org/TR/2024/REC-Fixture-2-20240101/',status:'Recommendation',date:'2024-01-01',_links:{self:{href:edition}}})]]);
 const tools=createSqaResearch({session:f.session,checkpoint:async()=>{},retrieve:async url=>{
  const document=responses.get(url);assert.ok(document);
  return {url,finalUrl:url,content:document,contentHash:createHash('sha256').update(document).digest('hex'),retrievedAt:Date.now()};
 }});
 const invoke=(name,input)=>tools.find(t=>t.name===name).run(input);
 const source=await invoke('web_fetch',{url:shortlink});
 assert.equal(source.authority,'verified_official');
 const {requirement}=await invoke('sqa_record_requirement',{source_id:source.sourceId,framework:'Fixture Standard',control_id:'F1',quote:'Visible control names should be discoverable.'});
 const surfaces=modeDiscoveryStatus(f.session).features.filter(feature=>feature.kind==='surface');
 for (const [i,feature] of surfaces.entries()) {
  const {decision}=await invoke('sqa_record_applicability',{classification:'RECOMMENDED',obligation:'recommended_practice',feature_ids:[feature.id],requirement_ids:[requirement.id],jurisdiction:'Fixture only',rationale:'Observed interactive surface',assumptions:[]});
  const id='scope-'+i;
  const invalid=await f.run('mode_plan_work',{workflows:[{id,title:feature.name,feature_ids:[feature.id],applicability_id:decision.id,control_ids:[requirement.controlId],steps:['Check names'],expected_behavior:'Controls expose names'}]});
  assert.equal(invalid.code,'MODE_CONTROL_SCOPE');assert.match(invalid.error,/Omit control_ids/);
  assert.equal((await f.run('mode_plan_work',{workflows:[{id,title:'Inspect '+feature.name,feature_ids:[feature.id],applicability_id:decision.id,steps:['Check rendered names'],expected_behavior:'Controls expose names'}]})).success,true);
  await f.run('mode_start_workflow',{id});await f.move(feature.location);
  await f.run('mode_test_surface',{checks:['accessibility']});
  assert.equal((await f.run('mode_close_workflow',{id,disposition:'verified'})).success,true);
 }
 const persisted=JSON.parse(JSON.stringify(f.session));
 const result=standaloneResearchReadiness(persisted);
 assert.deepEqual(result.blockers,[]);
 assert.equal(result.ready,true);
 assert.equal(result.report.metrics.testsWithEvidence,surfaces.length);
 assert.equal(result.report.requirements[0].requirementResult,'NOT_VERIFIABLE');
 const background=structuredClone(persisted);
 background.sqa.execution.research.requirements[0].controlId='abstract';
 const backgroundResult=standaloneResearchReadiness(background);
 assert.equal(backgroundResult.ready,false);
 assert.equal(backgroundResult.report.requirements[0].citationUse,'background');
 assert.ok(backgroundResult.blockers.some(reason=>reason.includes('Background material')));
 const {attachResearchReport}=await import('./sqaResearchReport.js');
 const {buildSqaReportMarkdown,evaluateSqaAssessment}=await import('./sqaAssessment.js');
 const {buildReportHtml}=await import('./reportPdf.js');
 const scope=createSqaState({authorizationConfirmed:true,target:{name:'Fixture',release:'test',environment:'local'}}).scope;
 const evaluated=evaluateSqaAssessment({target:scope.target,profiles:scope.profiles,attributes:scope.attributes,observations:[],assessedAt:new Date().toISOString()});
 const attached=attachResearchReport(evaluated,result.report);
 assert.equal(attached.passed,false);
 assert.equal(attached.gates.at(-1).status,'blocked');
 assert.ok(buildSqaReportMarkdown(attached).includes(source.contentHash));
 assert.ok(buildReportHtml({...persisted,createdAt:Date.now(),sqa:{...persisted.sqa,assessment:attached}}).includes(source.contentHash));
 assert.ok(researchMarkdown(result.report).includes(source.contentHash));
 assert.equal(persisted.sqa.execution.telemetry.classifier.calls,0);
 persisted.sqa.execution.workflows[0].verification.receipts[0].digest='altered';
 assert.equal(standaloneResearchReadiness(persisted).ready,false);
});
