/** Live Opus/JEV + installed CleanSlate SDK + real browser qualification.
 * Explicit opt-in; disposable loopback workspace only; no account/config writes. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {ensureRuntime,runTurn,deleteRunSnapshot} from '../server/agent.js';
import {getConfig,withUserConfiguration} from '../server/config.js';
import {hybridProfile,loadQualification} from '../server/hybridConfig.js';
import {hybridCompletion,validateHybridFinding} from '../server/qaCompletionGate.js';
import {qaScenarioSchedule} from '../server/qaScenarioScheduler.js';
import {scenarioExecutionAccount} from '../server/qaExecutionState.js';
import {qaSchedulerFixture} from '../server/qaSchedulerFixture.js';
import {buildReportMarkdown} from '../server/report.js';
import {applicationDiscoveryStatus} from '../server/qaApplicationDiscovery.js';

assert.equal(process.env.QASE_LIVE_HYBRID_EXECUTION,'true','Explicit live-model opt-in is required.');
assert.equal(process.env.QASE_ALLOW_PRIVATE_NETWORK,'true');
assert.notEqual(process.env.NODE_ENV,'production');
const defects=process.argv.includes('--realistic');
const variant=defects?'realistic':'healthy';
const settings={...getConfig(),headless:true};loadQualification(hybridProfile(settings));
const fixture=qaSchedulerFixture({defects});fixture.server.listen(0,'127.0.0.1');await once(fixture.server,'listening');
const targetUrl=`http://127.0.0.1:${fixture.server.address().port}/`;
const root=fs.mkdtempSync(path.join(os.tmpdir(),`qase-scheduler-${variant}-`));
const output=path.resolve(process.env.QASE_SCHEDULER_OUTPUT||'test-results/qa-scheduler',variant);
fs.mkdirSync(output,{recursive:true});
const specification='The Home page heading must contain Team practice workspace. All fixture routes, FAQ disclosure, task view tabs, local search, synthetic input positive/negative cases, responsive layout, media, accessible names, fragments, navigation history and console diagnostics are authorized. No form submissions, authentication, external requests or persistent writes are needed.';
const session={id:randomUUID(),ownerUserId:'isolated-qa-scheduler',mode:'qa',qaExecutionMode:'hybrid',qaDiscoveryVersion:1,status:'idle',targetUrl,
 selectedTests:['navigation','responsive','forms','search','media','accessibility','console_health','broken_links','content'],messages:[{role:'user',text:specification}],activities:[],findings:[],todos:[],secretNames:[]};
const live={},events=[];
const save=()=>{fs.writeFileSync(path.join(root,'checkpoint.tmp'),JSON.stringify(session),{mode:0o600});fs.renameSync(path.join(root,'checkpoint.tmp'),path.join(root,'checkpoint.json'));};
const store={liveFor:()=>live,listLive:()=>[],publish(_s,type){events.push({type,ts:Date.now()});},async commit(){save();},async setStatus(s,status,detail){s.status=status;s.statusDetail=detail;save();},
 async addActivity(s,item){const a={id:randomUUID(),ts:Date.now(),...item};s.activities.push(a);return a;},async updateActivity(s,id,patch){Object.assign(s.activities.find(a=>a.id===id),patch);save();},async addMessage(s,item){const m={id:randomUUID(),ts:Date.now(),...item};s.messages.push(m);return m;}};
let record,error,timedOut=false,initialized;
const began=Date.now(),memoryBefore=process.memoryUsage();
const timer=setTimeout(()=>{timedOut=true;live.userStopRequested=true;live.controller?.abort();},600000);timer.unref();
try{
 try{
 await withUserConfiguration(settings,async()=>{throw new Error('Configuration writes forbidden.');},async()=>{
  record=await ensureRuntime(session,store);initialized=Date.now();
  const discoveryController=new AbortController();
  await record.hybrid.beginTurn(discoveryController.signal);
  await record.hybrid.tools.find(t=>t.name==='qa_discover_application').run({}, {signal:discoveryController.signal});
  assert.equal(applicationDiscoveryStatus(session).ready,true);
  await record.hybrid.endTurn('ready');
  const observedFeatures=applicationDiscoveryStatus(session).features;
  const disclosureFeatures=observedFeatures.filter(f=>f.location===targetUrl&&f.kind==='disclosure').map(f=>f.id).slice(0,1);
  const tabFeatures=observedFeatures.filter(f=>f.location===targetUrl&&f.kind==='tab').map(f=>f.id).slice(0,2);
  assert.ok(disclosureFeatures.length&&tabFeatures.length,'The fixture custom scenarios require actual discovered controls.');
  const content=session.hybrid.scenarios.find(s=>s.category==='content');
  await record.hybrid.ledger.plan([{id:content.id,category:'content',objective:'Verify the specified Home heading',expected:{source:'request',text:'Team practice workspace'}},
    {category:'navigation',feature_ids:disclosureFeatures,objective:'Verify FAQ expansion and keyboard behavior',expected:{source:'hypothesis',text:'Native disclosure opens, closes and exposes its content.'}},
    {category:'navigation',feature_ids:tabFeatures,objective:'Verify task-view tabs select and reveal declared panels',expected:{source:'hypothesis',text:'Each tab selects exactly one visible panel.'}}]);
  assert.equal(session.hybrid.scenarios.length,11);
  await runTurn(session,{task:`Test ONLY the authorized disposable task workspace at ${targetUrl}. ${specification} Use the existing eleven host scenarios, not duplicate plan items. First inspect and run default qa_test_routes batches over the four observed pages and any discovered in-scope states. Then execute BOTH extra navigation scenarios independently: browser_qa_scenario with disclosure on the observed FAQ selector, and browser_qa_scenario with tabs on Home. The content scenario needs browser_snapshot plus qa_assert_snapshot text_contains the exact authorized phrase Team practice workspace. Load the approved assertion tool if needed. These three custom expectations require actual host assertions beyond default route batches. Use qa_work_schedule to select unfinished work and investigate recoverable execution gaps with fresh observations; do not repeat accounted checks to manufacture a pass. Review actual input negative cases and restore values/viewport. File only safely reproduced host failures. Finish through finish_qa_report only when the host schedule has no executable unresolved work.`},store);
 });
 }catch(cause){error={name:cause.name,code:cause.code,message:cause.message};}
 save();
 const state=session.hybrid,completion=state&&hybridCompletion(session),schedule=state&&qaScenarioSchedule(session,scenarioExecutionAccount);
 const durable=JSON.parse(fs.readFileSync(path.join(root,'checkpoint.json')));
 assert.ok(JSON.stringify(durable.hybrid)===JSON.stringify(state),'Durable hybrid checkpoint differs from live state.');
 assert.ok(JSON.stringify(durable.report)===JSON.stringify(session.report),'Durable report differs from live report.');
 const groups=[...new Set(session.findings.map(f=>{const s=state.scenarios.find(s=>s.id===f.hybridEvidence?.scenarioId);return `${s?.category}:${new URL(f.url||targetUrl).pathname}`;}))];
 for(const f of session.findings)validateHybridFinding(session,{scenario_id:f.hybridEvidence?.scenarioId,assertion_id:f.hybridEvidence?.assertionId});
 const verified=state?.scenarios.filter(s=>['passed','failed'].includes(s.status)&&s.assertions.length).length||0;
 const exercised=state?.scenarios.filter(s=>s.assertions.length&&scenarioExecutionAccount(session,s).attempted).length||0;
 const tokens=(state?.telemetry.reasoner.inputTokens||0)+(state?.telemetry.reasoner.outputTokens||0)+(state?.telemetry.classifier.inputTokens||0)+(state?.telemetry.classifier.outputTokens||0);
 const result={discovery:applicationDiscoveryStatus(session),runId:session.id,variant,status:session.status,detail:session.statusDetail,error,timedOut,elapsedMs:Date.now()-began,initializationMs:initialized?initialized-began:null,
  transport:'live configured Opus + JEV through installed CleanSlate SDK',sdkRunUnmodified:record&&record.runtime.run===Object.getPrototypeOf(record.runtime).run,
  scenarioCounts:completion?.counts,accountability:completion?.accountability,verifiedCoverage:completion?.coverage,verifiedScenarios:verified,exercisedScenarios:exercised,totalTokens:tokens,tokensPerVerifiedScenario:verified?tokens/verified:null,
  modelUsage:state?.telemetry,reportPublished:Boolean(session.report),verdict:session.report?.verdict,frontier:state?.exploration.routes.map(({url,status,kind})=>({path:new URL(url).pathname,status,kind})),
  browserActionsPerScenario:verified?(state.telemetry.browserActions/verified):null,duplicateActionKeys:state?.repeatActions.filter(a=>a.count>1).map(({toolName,count})=>({toolName,count})),
  unresolvedSchedule:schedule?.unresolved.map(({id,category,needsInvestigation})=>({id,category,needsInvestigation})),
  negativeInputCases:state?.evidence.reduce((n,e)=>n+(e.result.formTesting?.negativeCases||0),0),inputFieldsFilled:state?.evidence.reduce((n,e)=>n+(e.result.formTesting?.fieldsFilled||0),0),
  foundDefectGroups:groups,expectedDefectGroups:fixture.expectedDefects,writes:fixture.writes(),checkpointRoundTrip:true,
  evidenceRefs:state?.scenarios.map(s=>({scenarioId:s.id,objective:s.objective,status:s.status,assertions:s.assertions.length,evidenceRefs:s.evidenceRefs})),
  toolFailures:session.activities.filter(a=>a.status==='failed').map(a=>({tool:a.toolName,error:a.error})),memory:{before:memoryBefore,after:process.memoryUsage()},root};
 fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2),{mode:0o600});
 if(session.report)fs.writeFileSync(path.join(root,'report.md'),buildReportMarkdown(session),{mode:0o600});
 for(const name of ['result.json','checkpoint.json','report.md'])if(fs.existsSync(path.join(root,name))){fs.copyFileSync(path.join(root,name),path.join(output,name));fs.chmodSync(path.join(output,name),0o600);}
 console.log(JSON.stringify({runId:result.runId,variant,status:result.status,accountability:result.accountability,verifiedScenarios:verified,totalTokens:tokens,elapsedMs:result.elapsedMs,reportPublished:result.reportPublished,error,output}));
 assert.equal(error,undefined);assert.equal(timedOut,false);assert.equal(session.status,'done',session.statusDetail);assert.equal(schedule.total,11);assert.equal(schedule.accounted,11);assert.equal(schedule.unresolved.length,0);
 assert.equal(exercised,11,'Every fixture scenario requires actual host assertions, not a prose disposition.');assert.ok(session.report);assert.equal(fixture.writes(),0);
 assert.ok(result.inputFieldsFilled>=3);assert.ok(result.negativeInputCases>=3);assert.equal(result.sdkRunUnmodified,true);
 for(const p of fixture.expectedPaths)assert.ok(result.frontier.some(r=>r.path===p&&r.status==='tested'),`Untested fixture page ${p}`);
 for(const group of fixture.expectedDefects)assert.ok(groups.includes(group),`Seeded defect not confirmed: ${group}`);
 assert.deepEqual([...groups].sort(),[...fixture.expectedDefects].sort(),'Fixture qualification must reject unexpected defect groups.');
 assert.equal(state.telemetry.reasoner.reservedTokens,0);assert.equal(state.telemetry.classifier.reservedTokens,0);
}finally{clearTimeout(timer);await record?.bridge?.service?.dispose?.();record?.dispose?.();deleteRunSnapshot(session.id);fixture.server.closeAllConnections();fixture.server.close();}
