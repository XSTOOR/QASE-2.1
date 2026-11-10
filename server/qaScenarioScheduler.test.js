import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createHybridRuntime} from './hybridQaRuntime.js';
import {hybridProfile} from './hybridConfig.js';
import {qaScenarioSchedule} from './qaScenarioScheduler.js';
import {scenarioExecutionAccount} from './qaExecutionState.js';
import {validateHybridReport,hybridCompletion,hybridUnreportedFindings} from './qaCompletionGate.js';
import {createQaTools} from './qaTools.js';
import {recordInferenceProgress} from './qaInferenceProgress.js';

function fixture(checks=['navigation']){
 const session={id:randomUUID(),mode:'qa',qaExecutionMode:'hybrid',ownerUserId:'owner',targetUrl:'https://fixture.test/',selectedTests:checks,messages:[],findings:[],todos:[]};
 const runtime=createHybridRuntime({session,record:{},profile:hybridProfile({apiKey:'fixture'},{}),runStore:{async commit(){}}});
 return {session,runtime,ledger:runtime.ledger,state:session.hybrid};
}
const schedule=f=>qaScenarioSchedule(f.session,scenarioExecutionAccount);
async function check(f,input,result){const a=await f.ledger.beginAction('browser_qa_check',input);return f.ledger.record(a,{url:f.session.targetUrl,...result});}
async function observation(f,url=f.session.targetUrl){const a=await f.ledger.beginAction('browser_snapshot',{});return f.ledger.record(a,{success:true,url,bodyText:'Fresh rendered state'});}
const assertion=check=>({check,name:`${check} contract`,expected:true,actual:true,outcome:'pass'});

test('historical 3/11 shape: terminal labels, spare budget and an exhausted route frontier cannot forgive execution gaps',async()=>{
 const f=fixture(['navigation','forms','authentication','search','responsive','console_health','broken_links','media','accessibility','content','visual_consistency']);
 f.state.exploration.routes=[{id:'observed',url:f.session.targetUrl,status:'tested'}];
 for(const s of f.state.scenarios){
  if(['authentication','content','visual_consistency'].includes(s.category)){await f.ledger.close(s.id,'blocked','No authorized scenario specification.');continue;}
  await f.ledger.start(s.id);
  if(s.category==='console_health'){
   const a=await f.ledger.beginAction('browser_diagnostics',{}),e=await f.ledger.record(a,{success:true,url:f.session.targetUrl,console:[]});
   await f.ledger.assertDiagnostics({scenarioId:s.id,evidenceId:e.id});
  }else await check(f,{action:s.category==='broken_links'?'anchors':s.category},{success:true,assertions:['forms','search','accessibility'].includes(s.category)?[assertion(s.category)]:[],...(['navigation','responsive'].includes(s.category)?{gaps:['Observed control could not execute.']}: {})});
  await f.ledger.close(s.id,s.assertions.length?'complete':'inconclusive','The sampled tool did not establish the workflow.');
 }
 assert.equal(f.state.scenarios.every(s=>!['planned','running'].includes(s.status)),true);
 assert.deepEqual(schedule(f).unresolved.map(s=>s.category),['navigation','responsive']);
 assert.throws(()=>validateHybridReport(f.session,{verdict:'partial'}),{code:'HYBRID_EXECUTION_PENDING'});
 assert.ok(f.state.telemetry.reasoner.inputTokens<f.state.budgets.reasonerTokens);
 assert.equal(f.session.report,undefined);
});

test('invalid pre-dispatch input is not an attempt and cannot become a prose skip',async()=>{
 const f=fixture(),s=f.state.scenarios[0];await f.ledger.start(s.id);
 await check(f,{action:'navigation'},{success:false,dispatched:false,error:'Missing observed selector and exact URL.'});
 assert.equal(scenarioExecutionAccount(f.session,s).attempted,false);
 await assert.rejects(f.ledger.close(s.id,'not_executed','No navigation available'),/actual attempt/);
});

test('typed stale-control input refusal cannot poison a later actual scenario execution',async()=>{
 const f=fixture(),s=f.state.scenarios[0];await f.ledger.start(s.id);
 await check(f,{action:'disclosure',selector:'#on-another-page'},{success:false,dispatched:false,code:'QA_CONTROL_STALE',assertions:[],error:'No click was dispatched.'});
 assert.equal(scenarioExecutionAccount(f.session,s).attempted,false);
 await assert.rejects(f.ledger.close(s.id,'not_executed','The selector was missing'),/actual attempt/);
 await check(f,{action:'disclosure',selector:'#actual-observed-control'},{success:true,assertions:[assertion('navigation')]});
 await f.ledger.close(s.id,'complete');assert.equal(s.status,'passed');assert.equal(schedule(f).accounted,1);
 assert.equal(s.executionGaps?.length||0,0);assert.equal(f.state.evidence.length,2,'The refused input receipt is retained.');
});

test('typed host safety exclusions remain coverage gaps without forcing repeated protected-field probes',async()=>{
 const f=fixture(['forms']),s=f.state.scenarios[0];await f.ledger.start(s.id);
 const message='Prefilled, sensitive, unsupported or excess controls were not modified; remaining inputs are outside this bounded sample.';
 await check(f,{action:'forms'},{success:true,assertions:[assertion('forms')],gaps:[message],coverageLimitations:[{code:'QA_INPUT_SAMPLE_LIMIT',message,excludedControls:1}]});
 await f.ledger.close(s.id,'complete');
 assert.equal(schedule(f).accounted,1);assert.equal(s.status,'inconclusive');assert.equal(hybridCompletion(f.session).coverage,0);
 assert.ok(hybridCompletion(f.session).gaps.length);assert.equal(validateHybridReport(f.session,{verdict:'partial'}).verdict,'partial');
});

test('a safety exclusion cannot forgive an additional timeout in the same browser result',async()=>{
 const f=fixture(['forms']),s=f.state.scenarios[0];await f.ledger.start(s.id);
 await check(f,{action:'forms'},{success:true,assertions:[assertion('forms')],gaps:['Protected field','Editable field timed out'],coverageLimitations:[{code:'QA_INPUT_SAMPLE_LIMIT',message:'Protected field',excludedControls:1}]});
 await f.ledger.close(s.id,'complete');
 assert.equal(schedule(f).next.needsInvestigation,true);assert.throws(()=>validateHybridReport(f.session,{verdict:'partial'}),{code:'HYBRID_EXECUTION_PENDING'});
});

test('fresh same-page observation permits a bounded investigation; unrelated control success cannot discharge its gap',async()=>{
 const f=fixture(),s=f.state.scenarios[0];await f.ledger.start(s.id);
 await check(f,{action:'navigation_control',selector:'#blocked'},{success:false,dispatched:true,error:'Click outcome not verified.'});
 await f.ledger.close(s.id,'inconclusive','Requires new state verification.');
 const wrong=await observation(f,'https://fixture.test/unrelated');
 await assert.rejects(f.ledger.investigate(s.id,wrong.id),/fresh intact/);
 const fresh=await observation(f);await f.ledger.investigate(s.id,fresh.id);
 await assert.rejects(f.ledger.close(s.id,'inconclusive','Just looked again'),/actual new check/);
 await check(f,{action:'navigation_control',selector:'#other'},{success:true,assertions:[assertion('navigation')]});
 await f.ledger.close(s.id,'complete');
 assert.equal(schedule(f).next.needsInvestigation,true);
 await assert.rejects(f.ledger.investigate(s.id,fresh.id),/fresh intact/);
});

test('a successful exact matching recheck can resolve a verified pre-dispatch refusal without erasing its receipt',async()=>{
 const f=fixture(),s=f.state.scenarios[0];await f.ledger.start(s.id);
 const refused=await check(f,{action:'navigation_control',selector:'#projects'},{success:false,dispatched:false,error:'Overlay intercepted before dispatch.'});
 const fresh=await observation(f);await f.ledger.investigate(s.id,fresh.id);
 await check(f,{action:'navigation_control',selector:'#projects'},{success:true,assertions:[assertion('navigation')]});
 await f.ledger.close(s.id,'complete');
 assert.equal(schedule(f).accounted,1);assert.equal(s.status,'passed');
 assert.ok(f.state.evidence.some(e=>e.id===refused.id));assert.ok(s.executionGaps[0].resolvedBy);
});

test('uncertain actions and unverified recovery prohibit investigation and publication',async()=>{
 const f=fixture(),s=f.state.scenarios[0];await f.ledger.start(s.id);
 await check(f,{action:'navigation_control',selector:'#projects'},{success:false,dispatched:true,error:'Transport interrupted.'});
 await f.ledger.close(s.id,'inconclusive','Unknown state');const fresh=await observation(f);
 f.state.actions[0].status='uncertain';
 await assert.rejects(f.ledger.investigate(s.id,fresh.id),/Uncertain mutations/);
 assert.throws(()=>validateHybridReport(f.session,{verdict:'partial'}),{code:'HYBRID_RECOVERY_PENDING'});
 f.state.actions[0].status='failed';f.state.recovery={verificationRequired:true};
 await assert.rejects(f.ledger.investigate(s.id,fresh.id),/Verify action state/);
});

test('dependencies schedule parents first, reject cycles atomically, and account blocked dependents without inventing execution',async()=>{
 const f=fixture(['navigation','search']),[parent,child]=f.state.scenarios;
 await f.ledger.plan([{id:child.id,category:'search',objective:child.objective,expected:child.expected,depends_on:[parent.id]}]);
 assert.equal(schedule(f).next.id,parent.id);assert.deepEqual(schedule(f).waiting[0].waitingFor,[parent.id]);
 await assert.rejects(f.ledger.start(child.id),/dependencies/);
 await assert.rejects(f.ledger.plan([{id:parent.id,category:'navigation',objective:parent.objective,expected:parent.expected,depends_on:[child.id]}]),/cycle/);
 assert.deepEqual(f.ledger.scenario(parent.id).dependsOn,[]);
 const p=f.ledger.scenario(parent.id);await f.ledger.start(p.id);
 await check(f,{action:'navigation'},{success:true,assertions:[]});
 await f.ledger.close(p.id,'inconclusive','No eligible links on rendered page.');
 await f.ledger.close(child.id,'blocked','Parent navigation prerequisite could not be established.');
 assert.equal(schedule(f).accounted,2);assert.equal(scenarioExecutionAccount(f.session,f.ledger.scenario(child.id)).attempted,false);
 assert.equal(hybridCompletion(f.session).coverage,0);
});

test('investigations are capped and never reset historical assertions or authorize new budget',async()=>{
 const f=fixture(),s=f.state.scenarios[0];await f.ledger.start(s.id);
 const budgets=structuredClone(f.state.budgets);
 for(let i=0;i<3;i++){
  await check(f,{action:'navigation_control',selector:'#projects'},{success:false,dispatched:true,error:'State still unavailable.'});
  await f.ledger.close(s.id,'inconclusive','Recorded failure needs owner context.');
  const fresh=await observation(f);
  if(i<2)await f.ledger.investigate(s.id,fresh.id);else await assert.rejects(f.ledger.investigate(s.id,fresh.id),/remaining bounded/);
 }
 assert.equal(s.investigations.length,2);assert.equal(schedule(f).recoveryBlocked[0].canInvestigate,false);
 assert.deepEqual(f.state.budgets,budgets);assert.equal(f.session.report,undefined);
});

test('exhausted investigations are recovery-blocked, never advertised as ready executable work',async()=>{
 const f=fixture(),s=f.state.scenarios[0];await f.ledger.start(s.id);
 for(let i=0;i<3;i++){
  await check(f,{action:'navigation_control',selector:'#projects'},{success:false,dispatched:true,error:'State still unavailable.'});
  await f.ledger.close(s.id,'inconclusive','Recorded failure needs owner context.');
  if(i<2)await f.ledger.investigate(s.id,(await observation(f)).id);
 }
 const work=schedule(f);
 assert.equal(work.ready.length,0,'A non-executable investigation must not send the model back to the same check.');
 assert.equal(work.recoveryBlocked[0].id,s.id);
 assert.equal(work.recoveryBlocked[0].canInvestigate,false);
 assert.throws(()=>validateHybridReport(f.session,{verdict:'partial'}),{code:'HYBRID_EXECUTION_PENDING'});
});

test('the next SDK inference hands off exhausted recovery before billing another reasoning call',async()=>{
 const f=fixture(),s=f.state.scenarios[0];await f.ledger.start(s.id);
 for(let i=0;i<3;i++){
  await check(f,{action:'navigation_control',selector:'#projects'},{success:false,dispatched:true,error:'Verified action could not finish.'});
  await f.ledger.close(s.id,'inconclusive','Requires an alternative access path.');
  if(i<2)await f.ledger.investigate(s.id,(await observation(f)).id);
 }
 let calls=0;const service={async chat(){calls++;throw new Error('No extra model request is permitted for the exhausted schedule.');}};
 f.runtime.wrapChat(service);const parts=[];
 for await(const part of await service.chat([],{tools:[{name:'qa_work_schedule',parametersSchema:{type:'object'}}]}))parts.push(part);
 assert.equal(calls,0);assert.equal(parts[0].call.toolName,'ask_question');
 assert.equal(f.state.pendingDecision.kind,'coverage');assert.equal(f.session.report,undefined);
});

test('host scheduler offers an existing pending route through the SDK after stagnant reasoning and checkpoints its identity',async()=>{
 const f=fixture();f.state.exploration.routes=[{id:'observed-entry',url:f.session.targetUrl,source:f.session.targetUrl,status:'pending'}];
 recordInferenceProgress(f.state);f.state.inferenceProgress.stagnantTurns=2;
 const service={async chat(){throw new Error('The host batch should not spend another model call.');}};f.runtime.wrapChat(service);
 const parts=[];for await(const p of await service.chat([],{tools:[f.runtime.tools.find(t=>t.name==='qa_test_routes')]}))parts.push(p);
 assert.equal(parts[0].call.toolName,'qa_test_routes');assert.deepEqual(parts[0].call.input,{route_ids:['observed-entry']});
 assert.equal(f.state.scheduler.hostDispatches.length,1);assert.equal(f.state.telemetry.reasoner.calls,0);
 assert.equal(f.session.report,undefined);assert.equal(f.state.scenarios[0].status,'planned');
});

test('accountable unsupported security scope stays blocked and never becomes a passed assertion',async()=>{
 const f=fixture(['security_sql_injection']),s=f.state.scenarios[0];
 await f.ledger.close(s.id,'blocked','No authorized active security payload workflow or reviewer evidence was supplied.');
 assert.equal(schedule(f).accounted,1);assert.equal(schedule(f).attempted,0);assert.equal(s.assertions.length,0);
 assert.equal(hybridCompletion(f.session).verdict,'blocked');assert.equal(hybridCompletion(f.session).coverage,0);
});

test('reproduced failures cannot disappear from a completed plan without an evidence-linked finding',async()=>{
 const f=fixture(['responsive']),s=f.state.scenarios[0];await f.ledger.start(s.id);
 const repro={confirmed:true,observations:2,kind:'deterministic-fixture'};
 await check(f,{action:'responsive'},{success:true,assertions:[{check:'responsive',name:'No horizontal overflow at 390px',outcome:'fail',expected:'Content fits viewport',actual:'500px exceeds 390px',reproduction:repro},{check:'responsive',name:'No horizontal overflow at 391px',outcome:'fail',expected:'Content fits viewport',actual:'500px exceeds 391px',reproduction:repro}]});
 await f.ledger.close(s.id,'complete');
 assert.equal(schedule(f).accounted,1);assert.equal(hybridUnreportedFindings(f.session).length,1,'Related viewport assertions can share one consolidated finding.');
 assert.throws(()=>validateHybridReport(f.session,{verdict:'partial'}),{code:'HYBRID_UNREPORTED_FINDINGS'});
 const tools=createQaTools(f.session,{async commit(){}}),pending=hybridUnreportedFindings(f.session)[0];
 const filed=await tools.find(t=>t.name==='report_finding').run({scenario_id:pending.scenarioId,assertion_id:pending.assertionId,title:'Fixture content exceeds the viewport',severity:'medium'});
 assert.equal(filed.success,true);assert.equal(hybridUnreportedFindings(f.session).length,0);
 assert.equal(validateHybridReport(f.session,{verdict:'partial'}).hybridEvidence.confirmedDefects,1);
});

test('identical assertion text on different surfaces cannot collapse into an unfileable finding loop',async()=>{
 const f=fixture(['responsive']),s=f.state.scenarios[0];await f.ledger.start(s.id);
 const a={check:'responsive',name:'No horizontal overflow',outcome:'fail',expected:'Content fits viewport',actual:'500px exceeds 390px',reproduction:{confirmed:true,observations:2,kind:'deterministic-fixture'}};
 await check(f,{action:'responsive'},{success:true,url:'https://fixture.test/',assertions:[a]});
 await check(f,{action:'responsive'},{success:true,url:'https://fixture.test/settings',assertions:[a]});
 await f.ledger.close(s.id,'complete');
 const report=createQaTools(f.session,{async commit(){}}).find(t=>t.name==='report_finding');
 for(const pending of hybridUnreportedFindings(f.session))assert.equal((await report.run({scenario_id:pending.scenarioId,assertion_id:pending.assertionId,title:'Surface overflows viewport',severity:'medium'})).success,true);
 assert.equal(f.session.findings.length,2);assert.equal(hybridUnreportedFindings(f.session).length,0);
 assert.equal((await report.run({scenario_id:s.id,assertion_id:s.assertions[1].id,title:'Repeated same finding',severity:'medium'})).total_findings,2);
});
