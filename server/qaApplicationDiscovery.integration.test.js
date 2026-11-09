import './testWorkingDirectory.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ensureRuntime, deleteRunSnapshot } from './agent.js';
import { hybridProfile, profileIdentity, REQUIRED_CAPABILITIES, HYBRID_SDK_VERSION } from './hybridConfig.js';
import { withUserConfiguration } from './config.js';
import { JEV_ENDPOINT } from './jevClient.js';
import { applicationDiscoveryStatus } from './qaApplicationDiscovery.js';
import { prepareHybridInference } from './hybridContext.js';

for (const checkScope of [['navigation','search','forms','responsive'], ['responsive']]) test(`real SDK discovery and scheduled feature execution (${checkScope.join(', ')})`, {skip:process.env.QASE_RUN_BROWSER_TESTS!=='1',timeout:90000}, async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qase-discovery-gate-'));
 const env={NODE_ENV:'development',QASE_ALLOW_PRIVATE_NETWORK:'true',QASE_HYBRID_QA_ENABLED:'true',QASE_LOCK_MODEL:'false',JEV_API_KEY:'discovery-fixture',QASE_HYBRID_QUALIFICATION_FILE:path.join(root,'qualification.json')};
 const saved=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
 t.after(()=>{for(const[k,v]of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;fs.rmSync(root,{recursive:true,force:true});});
 const settings={provider:'jev',model:'jev-1.13',baseUrl:JEV_ENDPOINT,apiKey:env.JEV_API_KEY,headless:true};
 fs.writeFileSync(env.QASE_HYBRID_QUALIFICATION_FILE,JSON.stringify({sdkVersion:HYBRID_SDK_VERSION,profileIdentity:profileIdentity(hybridProfile(settings)),checkedAt:Date.now(),capabilities:Object.fromEntries(REQUIRED_CAPABILITIES.map(n=>[n,{passed:true}]))}));
 let writes=0;
 const server=http.createServer((req,res)=>{
  if(req.method!=='GET')writes++;
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Workspace</title><nav><button id="projects">Projects</button><button id="meeting">Meeting</button><button id="about">About</button></nav><main><h1>Workspace</h1><div id="panel"><button>Overview</button></div></main><script>
  projects.onclick=()=>panel.innerHTML='<button id="details">Details</button><input type="search" aria-label="Search projects">';
  meeting.onclick=()=>panel.innerHTML='<button>Start meeting</button><button>Schedule</button>';
  about.onclick=()=>panel.innerHTML='<button>Help</button>';
  </script>`);
 });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const session={id:randomUUID(),ownerUserId:'fixture-owner',mode:'qa',qaExecutionMode:'hybrid',qaDiscoveryVersion:1,status:'idle',targetUrl:`http://127.0.0.1:${server.address().port}/`,selectedTests:checkScope,messages:[],activities:[],findings:[],todos:[],secretNames:[]};
 const live={},store={liveFor:()=>live,listLive:()=>[],publish(){},async commit(s){fs.writeFileSync(path.join(root,'checkpoint.json'),JSON.stringify(s));},async addActivity(s,a){const item={id:randomUUID(),...a};s.activities.push(item);return item;},async updateActivity(s,id,p){Object.assign(s.activities.find(a=>a.id===id),p);}};
 await withUserConfiguration(settings,async()=>{},async()=>{
  const record=await ensureRuntime(session,store);t.after(async()=>{await record.bridge.service.dispose();record.dispose();deleteRunSnapshot(session.id);});
  const controller=new AbortController();await record.hybrid.beginTurn(controller.signal);
  try {
  // No model response is mocked into a browser assertion. The native SDK
  // executor dispatches every observation/click to an actual browser here.
  record.hybrid.router.classifier=async()=>({});
  const tool=record.hybrid.tools.find(t=>t.name==='qa_discover_application');
  assert.equal(prepareHybridInference([], {tools:record.hybrid.tools},session).options.tools.some(t=>t.name==='qa_plan_scenarios'),false);
  await assert.rejects(record.hybrid.ledger.start(session.hybrid.scenarios[0].id),/discovery/i);
  const first=tool.run({}, {signal:controller.signal});
  await assert.rejects(tool.run({}, {signal:controller.signal}),/ownership/);
  const result=await first;
  assert.equal(result.discovery.ready,true,JSON.stringify(result.discovery));
  const d=applicationDiscoveryStatus(session);
  assert.ok(d.probes>=2);assert.ok(new Set(d.features.map(f=>f.stateKey)).size>=3,'Same-URL panels must remain separate states.');
  assert.ok(d.features.some(f=>f.kind==='search'));assert.equal(session.hybrid.scenarios.some(s=>s.assertions.length),false,'Discovery cannot fabricate executed scenarios.');
  assert.ok(session.hybrid.scenarios.every(s=>s.discoveryPlan));
  assert.ok(session.hybrid.exploration.routes.some(r=>r.kind==='feature'));
  const actions=session.hybrid.actions.length;await tool.run({}, {signal:controller.signal});assert.equal(session.hybrid.actions.length,actions,'Qualified discovery must be reused, not repeated.');
  const persisted=JSON.parse(fs.readFileSync(path.join(root,'checkpoint.json')));assert.equal(applicationDiscoveryStatus(persisted).ready,true);
  if (!checkScope.includes('navigation')) {
   const beforeActions=session.hybrid.actions.length;
   const blocked=await record.invokeHybridTool('browser_qa_check',{action:'navigation_control',selector:'#projects'},controller.signal);
   assert.equal(blocked.success,false);assert.match(blocked.error,/outside the selected test scope/);
   assert.equal(session.hybrid.actions.length,beforeActions,'The private setup capability must not be available to ordinary model actions.');
  }
  // Simulate an interrupted gate publication with the real observations still
  // durable. The host must schedule discovery through the native SDK itself.
  session.hybrid.discovery.status='pending';session.hybrid.discovery.completedAccess=undefined;
  let turns=0,read=false,scheduledDiscovery=false;
  record.runtime.cleanSlateService.chat=async(_messages,options)=>(async function*(){
   record.hybrid.usage({reservationId:options.qaseBudgetReservationId,callId:randomUUID(),inputTokens:20,outputTokens:5,estimated:false});
   assert.ok(options.tools.some(t=>t.name==='qa_discover_application'),'Discovery must be exposed through the real SDK allowed-tool catalog.');
   if(turns++===0)yield {type:'tool_call',call:{id:randomUUID(),toolName:'qa_read_discovery',input:{limit:2}}};
   else yield {type:'text',content:'The saved discovery inventory has been read; testing is not complete.'};
  })();
  record.hybrid.wrapChat(record.runtime.cleanSlateService);
  for await(const part of record.runtime.run('Read the saved discovery inventory only.',controller.signal)){
   if(part.type==='tool_result'&&part.toolName==='qa_discover_application')scheduledDiscovery=true;
   if(part.type==='tool_result'&&part.toolName==='qa_read_discovery'){read=true;assert.equal(part.result.features.length,2);}
  }
  assert.equal(scheduledDiscovery,true);assert.equal(session.hybrid.scheduler.hostDispatches[0].reason,'mandatory_discovery');
  assert.equal(read,true);assert.equal(session.report,undefined,'Ending an SDK segment cannot publish a report.');
  record.runtime.cleanSlateService.chat=async(_messages,options)=>(async function*(){
   record.hybrid.usage({reservationId:options.qaseBudgetReservationId,callId:randomUUID(),inputTokens:20,outputTokens:5,estimated:false});
   yield {type:'text',content:'The model stopped without executing the pending plan.'};
  })();
  record.hybrid.wrapChat(record.runtime.cleanSlateService);
  let batchExecuted=false;
  for(let segment=0;segment<4&&!batchExecuted;segment++){
   for await(const part of record.runtime.run('Continue the existing authorized plan.',controller.signal)){
    if(part.type==='tool_result'&&part.toolName==='qa_test_routes'){
     assert.equal(part.result.success,true);batchExecuted=true;break;
    }
   }
  }
  assert.equal(batchExecuted,true,'Stagnant model segments must not strand valid pending routes.');
  assert.ok(session.hybrid.scenarios.some(s=>s.assertions.length),'The host-scheduled SDK batch must actually execute browser assertions.');
  assert.ok(session.hybrid.scheduler.hostDispatches.some(d=>d.reason==='stalled_route_execution'));
  assert.equal(session.report,undefined,'Actual batch progress still requires independent final report validation.');
  assert.equal(writes,0);assert.equal(record.runtime.run,Object.getPrototypeOf(record.runtime).run);
  } finally { await record.hybrid.endTurn('paused'); }
 });
});
