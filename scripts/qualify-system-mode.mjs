/** Explicit live-model qualification against an isolated local fixture.
 * No production configuration, account settings or saved user runs are changed. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ensureRuntime, runTurn, deleteRunSnapshot } from '../server/agent.js';
import { getConfig, withUserConfiguration } from '../server/config.js';
import { createSqaState, createSqaTodoPlan } from '../server/sqaService.js';
import { createFounderState, createFounderReviewTodos, buildFounderReportMarkdown } from '../server/founderService.js';
import { buildSqaReportMarkdown } from '../server/sqaAssessment.js';
import { buildReportMarkdown } from '../server/report.js';

assert.equal(process.env.QASE_LIVE_SYSTEM_QUALIFICATION, 'true', 'Explicit live-model opt-in required.');
assert.notEqual(process.env.NODE_ENV, 'production');
const mode=process.argv[2]; assert.ok(['qa','sqa','founder'].includes(mode));
const publicTarget=process.env.QASE_SYSTEM_QUALIFICATION_TARGET;
if(publicTarget){const target=new URL(publicTarget);assert.equal(target.protocol,'https:');assert.ok(!target.username&&!target.password&&!target.search,'Only an explicitly authorized public target without embedded secrets is permitted.');}
else assert.equal(process.env.QASE_ALLOW_PRIVATE_NETWORK, 'true', 'Only the explicitly enabled loopback fixture is used.');
const deep=process.argv.includes('--deep');
assert.ok(!publicTarget||!deep,'Deep fixture assertions cannot be applied to an unrelated real website.');
const root=fs.mkdtempSync(path.join(os.tmpdir(),`qase-system-${mode}-`));
let writes=0;
const server=http.createServer((req,res)=>{
  if(req.method!=='GET'){writes++;res.writeHead(405).end();return;}
  res.setHeader('Content-Type','text/html');
  if(deep){
    const content=req.url==='/pricing'?'<h1>Team practice pricing</h1><p>Fixture offer: $19 per team per month, including task practice and shared documentation. Pricing is product copy, not evidence of sales.</p>':req.url==='/docs'?'<h1>Practice documentation</h1><p>Choose a task, enter a name of at least two characters, and save locally. Empty or one-character names must be rejected; a valid name displays Local task saved. Data is not sent to a server.</p>':req.url==='/practice'?'<h1>Practice a task</h1><form onsubmit="event.preventDefault();document.querySelector(\'output\').textContent=\'Local task saved\'"><label>Task name<input name="task" required minlength="2"></label><button>Save local task</button><output></output></form>':'<h1>Practice workspace for remote teams</h1><p>Discover and practice repeatable team tasks without sending private work to a server.</p><a href="/practice">Start practicing</a>';
    res.end(`<!doctype html><html lang="en"><title>Team practice fixture</title><nav><a href="/">Home</a><a href="/docs">Documentation</a><a href="/pricing">Pricing</a><a href="/practice">Practice</a></nav><main>${content}</main><footer>Contact and account workflows are not offered in this disposable fixture.</footer></html>`);return;
  }
  res.end(`<!doctype html><html lang="en"><title>Workflow fixture</title><nav><a href="/">Home</a><a id="docs" href="/docs">Documentation</a></nav><main><h1>${req.url==='/docs'?'Documentation':'Practice workspace'}</h1><p>Local fixture for small teams practicing a task. No customers, analytics or revenue are supplied.</p><label>Search tasks<input id="query" type="search" aria-controls="results"></label><ul id="results"><li>Alpha</li><li>Beta</li></ul><form onsubmit="event.preventDefault();document.querySelector('output').textContent='Local task saved'"><label>Task name<input name="task" required minlength="2"></label><button>Save local task</button><output></output></form></main><script>query.oninput=()=>results.innerHTML=['Alpha','Beta'].filter(x=>x.toLowerCase().includes(query.value.toLowerCase())).map(x=>'<li>'+x+'</li>').join('')</script></html>`);
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const url=publicTarget||`http://127.0.0.1:${server.address().port}/`, settings=getConfig();
let session={id:randomUUID(),ownerUserId:'isolated-qualification',mode,status:'idle',targetUrl:url,messages:[{role:'user',text:'Authorized public-only review. No authenticated workflow is in scope. No customer, revenue, analytics or assurance artifacts have been supplied.'}],activities:[],findings:[],todos:[],secretNames:[]};
if(mode==='qa'){session.qaExecutionMode='hybrid';session.selectedTests=['navigation','responsive','search','accessibility'];}
if(mode==='sqa'){
 session.sqa=createSqaState({authorizationConfirmed:true,profiles:['core'],attributes:['web_application','user_interface'],target:{name:publicTarget?new URL(url).hostname:'Practice fixture',url,release:publicTarget?'observed public snapshot':'test',environment:publicTarget?'authorized public target':'local'},scopeNotes:'Public-only assessment. Missing reviewer artifacts and unexecuted workflows must remain blocked.'});session.todos=createSqaTodoPlan(session.sqa);
}
if(mode==='founder'){
 session.founder=createFounderState({authorizationConfirmed:true,target:{name:publicTarget?'Authorized public product':'Practice fixture',url},productContext:publicTarget?{primaryGoal:'Review the publicly observable product, onboarding and product positioning; label business assumptions as hypotheses.'}:{stage:'Isolated MVP fixture',businessModel:'B2B subscription hypothesis',targetCustomer:'Small remote teams',primaryGoal:'Evaluate task discovery and practice',constraints:'Public-only fixture; no commercial outcomes supplied.'}});session.todos=createFounderReviewTodos();
}
const resumeFile=process.env.QASE_SYSTEM_QUALIFICATION_RESUME;
let priorElapsedMs=0;
if(resumeFile){
 assert.ok(publicTarget&&!deep&&mode!=='qa','Checkpoint resume is limited to isolated public-only mode qualification.');
 const saved=JSON.parse(fs.readFileSync(resumeFile,'utf8')),execution=saved[mode]?.execution;
 assert.equal(saved.ownerUserId,'isolated-qualification');assert.equal(saved.mode,mode);assert.equal(saved.targetUrl,url);
 assert.ok(['awaiting_input','interrupted','error'].includes(saved.status)&&!saved[mode].finalizedAt);
 assert.equal(saved.secretNames?.length||0,0);assert.equal(saved[mode].scope.authorization.confirmed,true);
 assert.ok(saved.messages.some(m=>m.role==='user'&&/public-only/i.test(m.text)));
 assert.ok(execution?.discovery&&execution.actions.every(a=>!['running','uncertain'].includes(a.status)),'No uncertain browser action may be resumed by this harness.');
 assert.ok(['reasoner','classifier'].every(role=>!execution.telemetry[role].reservedTokens),'Unverified usage requires provider reconciliation, never a fresh qualification reset.');
 session=saved;priorElapsedMs=execution.telemetry.elapsedMs||0;
}
const profileReasoner=()=> 'drytis/claude-opus-4.7';
const live={},events=[],screenshots=[],journeyStates=[];
let saveCalls=0,saveTotalMs=0,reportPersistenceMs;
const save=()=>{const start=performance.now(),file=path.join(root,'checkpoint.json');fs.writeFileSync(file+'.tmp',JSON.stringify(session),{mode:0o600});fs.renameSync(file+'.tmp',file);saveCalls++;saveTotalMs+=performance.now()-start;
 // runTurn installs its own SDK result callbacks. Observe committed receipts
 // instead of replacing a callback which the execution lifecycle later owns.
 for(const receipt of session[mode]?.execution?.evidence||[]){
  const observation=receipt.result;
  if(receipt.tool==='browser_snapshot'&&observation.url&&new URL(observation.url).pathname==='/practice'&&!journeyStates.some(item=>item.receiptId===receipt.id))journeyStates.push({receiptId:receipt.id,activityId:receipt.activityId,at:receipt.at,successVisible:/Local task saved/.test(observation.bodyText||'')});
 }
};
const store={liveFor:()=>live,listLive:()=>[],publish(_s,type,payload){
 events.push({type,ts:Date.now()});
 if(type==='frame'&&payload?.frame?.base64&&screenshots.length<8&&!screenshots.some(item=>item.url===payload.frame.url)){
  const name=`browser-${screenshots.length+1}.jpg`;fs.writeFileSync(path.join(root,name),Buffer.from(payload.frame.base64,'base64'),{mode:0o600});screenshots.push({name,url:payload.frame.url,ts:payload.frame.ts});
 }
},async commit(_s,type,payload){events.push({type,ts:Date.now()});const start=performance.now();save();if(type===`${mode}.finalized`||mode==='sqa'&&type==='sqa'&&payload?.final)reportPersistenceMs=performance.now()-start;},async setStatus(s,status,detail){s.status=status;s.statusDetail=detail;events.push({type:'status',status,ts:Date.now()});save();},async addActivity(s,item){const next={id:randomUUID(),ts:Date.now(),...item};s.activities.push(next);return next;},async updateActivity(s,id,patch){Object.assign(s.activities.find(a=>a.id===id),patch,...(['done','failed'].includes(patch.status)?[{completedAt:Date.now()}]:[]));save();},async addMessage(s,item){const next={id:randomUUID(),ts:Date.now(),...item};s.messages.push(next);return next;}};
const began=performance.now(),beganWall=Date.now(),beforeMemory=process.memoryUsage(),cpuStart=process.cpuUsage();let initialized,record,timedOut=false;
let sampledPeakRss=beforeMemory.rss;
const memorySampler=setInterval(()=>{sampledPeakRss=Math.max(sampledPeakRss,process.memoryUsage().rss);},250);memorySampler.unref();
// Realistic public review includes the same discovery and full synthesis as
// the deep fixture. This is the disposable harness ceiling, not an agent or
// gateway timeout increase; pinned runtime budgets still apply independently.
let qualificationDeadlineMs=deep||publicTarget?600000:240000;
const deadline=()=>{timedOut=true;live.userStopRequested=true;live.controller?.abort();};
let timer=setTimeout(deadline,qualificationDeadlineMs);timer.unref();
try{
 await withUserConfiguration(settings,async()=>{throw new Error('Account changes forbidden.');},async()=>{
  record=await ensureRuntime(session,store);initialized=performance.now();
  const approvedDuration=record.modeReasoning?.state.budgets.durationMs||session.hybrid?.budgets.durationMs;
  if(Number.isSafeInteger(approvedDuration)&&approvedDuration>0){
   // Do not manufacture a user stop before the host's already approved run
   // duration. The engine still enforces that pinned limit; five seconds is
   // only for recording its terminal checkpoint, never extra execution budget.
   clearTimeout(timer);qualificationDeadlineMs=Math.max(1,approvedDuration-priorElapsedMs)+5000;
   timer=setTimeout(deadline,Math.max(1,qualificationDeadlineMs-(performance.now()-began)));timer.unref();
  }
  await runTurn(session,{...(resumeFile&&session.pendingQuestion?{resumeAnswer:'Continue the already authorized public-only review using the available host tools. No additional scope, permissions, budget, credentials or completion-gate exceptions are granted.'}:{}),task:resumeFile?'Resume the preserved mode checkpoint. FIRST mode_verify_recovery to inspect the fresh browser without replaying completed actions. Then read mode_execution_progress: create a workflow with the next required observed route feature and use mode_run_workflow; classify immutable receipts with classify_mode_observations. Preserve lifetime usage, budgets, completed work and original public-only scope. Complete the original mode contract. Do not ask the user about host tool exposure or override the route/report gate.':`Complete the ${mode} workflow against ONLY ${url}. ${publicTarget?'This is an authorized public-only realistic product review. Do not submit forms, sign in, create accounts, send messages, make purchases or mutate server data.':'This is an authorized isolated public-only fixture.'} Use observed navigation and search, representative positive/negative local input checks where supported, responsive review, and diagnostics. Preserve evidence, never claim unsupported coverage or business facts. No credentials or additional scope questions are needed. FIRST mode_discover_application, THEN mode_plan_work with actual observed feature IDs and at least two distinct surfaces if available. For SQA map control_ids to the actual planned checks. Prefer mode_run_workflow to activate, navigate, execute ordered steps/native checks and close each workflow in one SDK call; individual tools remain available for investigation. Close workflows only after actual host assertions, then record the mode's own evidence-backed controls/lenses. Classify at least one intact modeEvidenceId receipt with JEV. ${deep?'Explore the observed Home, Documentation, Pricing and Practice surfaces. On Practice verify empty/one-character input cannot produce success, then enter Alpha and click Save local task: the output must become Local task saved. These are authorized reversible DOM-only actions with no server persistence. Complete this mode’s canonical plan and final report.':''} Disposition unavailable reviewer requirements explicitly. Finish through this mode's own report tool after its completion gates pass.`},store);
 });
 save();
 const artifact=mode==='qa'?session.report:mode==='sqa'?(session.sqa?.finalizedAt?session.sqa.assessment:null):(session.founder?.finalizedAt?session.founder.report:null);
 const durable=JSON.parse(fs.readFileSync(path.join(root,'checkpoint.json'),'utf8'));
 assert.equal(JSON.stringify(durable[mode==='qa'?'report':mode]),JSON.stringify(session[mode==='qa'?'report':mode]));
 const result={runId:session.id,mode,provider:settings.provider,model:mode==='qa'?session.hybrid?.reasoner.model:record.modeReasoning?profileReasoner():settings.model,status:session.status,detail:session.statusDetail,elapsedMs:Math.round(performance.now()-began),initializationMs:initialized?Math.round(initialized-began):null,timedOut,writes,activities:session.activities.length,browserActivities:session.activities.filter(a=>a.toolName?.startsWith('browser_')&&a.status==='done').length,failedActivities:session.activities.filter(a=>a.status==='failed').map(a=>({tool:a.toolName,error:a.error})),tokenUsage:session.tokenUsage,telemetry:session.hybrid?.telemetry||record.modeReasoning?.state.telemetry,modeExploration:record.modeReasoning?.state.routes,reportPublished:Boolean(artifact),verdict:artifact?.verdict,coverage:artifact?.coverage,checkpointRoundTrip:true,modelTransport:mode==='qa'||record.modeReasoning?'live Opus + JEV through installed SDK':'live configured provider through existing mode adapter',memory:{before:beforeMemory,after:process.memoryUsage(),sampledPeakRss},measurements:{timeToFirstBrowserActionMs:session.activities.find(a=>a.toolName?.startsWith('browser_'))?.ts-beganWall,firstCompletedInteractionMs:session[mode]?.execution?.actions.find(a=>a.interaction)?.at-beganWall,planningToolMs:session.activities.filter(a=>a.toolName==='update_todo'&&a.completedAt).reduce((n,a)=>n+a.completedAt-a.ts,0),checkpointWrites:saveCalls,checkpointWriteTotalMs:saveTotalMs,reportPersistenceMs,cpu:process.cpuUsage(cpuStart),browserChildCpu:'unmeasured',workerUtilization:'in-process fixture, no distributed worker'},screenshots,root};
 result.journeyStates=journeyStates;result.qualificationDeadlineMs=qualificationDeadlineMs;
 result.resumedFrom=resumeFile?{checkpoint:path.resolve(resumeFile),priorElapsedMs,lifetimeElapsedMs:session[mode].execution.telemetry.elapsedMs}:undefined;
 result.writeCounterScope=publicTarget?'Local fixture counter only; public-target write prevention is host policy, not a server-side audit.':'Isolated fixture server.';
 const firstInteraction=session[mode]?.execution?.actions.find(a=>a.status==='done'&&a.interaction);
 const interactionReceipt=session[mode]?.execution?.evidence.find(e=>e.actionId===firstInteraction?.id);
 result.measurements.firstInteractionDispatchMs=firstInteraction?.at-beganWall;
 result.measurements.firstCompletedInteractionMs=interactionReceipt?interactionReceipt.at-beganWall:undefined;
 fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2),{mode:0o600});
 if(artifact)fs.writeFileSync(path.join(root,'report.md'),mode==='qa'?buildReportMarkdown(session):mode==='sqa'?buildSqaReportMarkdown(artifact):buildFounderReportMarkdown(session.founder),{mode:0o600});
 const output=path.resolve(process.env.QASE_SYSTEM_QUALIFICATION_OUTPUT||'test-results/system-qualification',mode);fs.mkdirSync(output,{recursive:true});
 for(const name of ['checkpoint.json','result.json','report.md',...screenshots.map(s=>s.name)])if(fs.existsSync(path.join(root,name))){fs.copyFileSync(path.join(root,name),path.join(output,name));fs.chmodSync(path.join(output,name),0o600);}
 console.log(JSON.stringify({runId:result.runId,mode,status:result.status,reportPublished:result.reportPublished,verdict:result.verdict,elapsedMs:result.elapsedMs,root}));
 assert.equal(timedOut,false);assert.equal(writes,0);assert.equal(session.status,'done',session.statusDetail);assert.ok(artifact);
 if(deep&&record.modeReasoning){
  assert.ok(['/','/docs','/pricing','/practice'].every(p=>result.modeExploration.some(r=>r.reviewed&&new URL(r.url).pathname===p)),'All four fixture pages must be reviewed.');
  assert.ok(journeyStates.some(s=>s.successVisible),'A real Practice snapshot must show the successful local task.');
  assert.ok(journeyStates.filter(s=>!s.successVisible).length>=3,'Practice must retain before/after negative-input snapshots.');
  assert.ok(session.todos.every(t=>t.status==='completed'),'The canonical plan and publication task must be complete.');
 }
}finally{clearTimeout(timer);clearInterval(memorySampler);await record?.bridge?.service?.dispose?.();record?.dispose?.();deleteRunSnapshot(session.id);server.closeAllConnections();server.close();}
