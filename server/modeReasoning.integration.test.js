import './testWorkingDirectory.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {ensureRuntime,runTurn,deleteRunSnapshot} from './agent.js';
import {hybridProfile,profileIdentity,REQUIRED_CAPABILITIES,HYBRID_SDK_VERSION} from './hybridConfig.js';
import {JEV_ENDPOINT} from './jevClient.js';
import {withUserConfiguration} from './config.js';
import {createSqaState} from './sqaService.js';
import {createFounderState,createFounderReviewTodos} from './founderService.js';
import {modeDiscoveryStatus} from './modeDiscovery.js';

// Deterministic model fixtures exercise the installed SDK and real browser;
// these are integration regressions, not evidence of live gateway qualification.
for(const composition of [false,true])for(const mode of ['sqa','founder'])test(`${mode}: native SDK ${composition?'bounded workflow':'batches'} persists browser evidence before dependent tools and final prose cannot publish`,{timeout:30000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qase-mode-sdk-'));
 const env={NODE_ENV:'development',QASE_ALLOW_PRIVATE_NETWORK:'true',QASE_LOCK_MODEL:'false',[`QASE_${mode.toUpperCase()}_REASONING_ENABLED`]:'true',QASE_HYBRID_QUALIFICATION_FILE:path.join(root,'qualification.json')};
 const saved=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
 t.after(()=>{for(const[key,value]of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;fs.rmSync(root,{recursive:true,force:true});});
 const settings={provider:'jev',baseUrl:JEV_ENDPOINT,model:'jev-1.13',apiKey:'fixture-only-mode-key',headless:true,maxTurns:2},profile=hybridProfile(settings);
 fs.writeFileSync(env.QASE_HYBRID_QUALIFICATION_FILE,JSON.stringify({sdkVersion:HYBRID_SDK_VERSION,profileIdentity:profileIdentity(profile),checkedAt:Date.now(),capabilities:Object.fromEntries(REQUIRED_CAPABILITIES.map(name=>[name,{passed:true}]))}));
 let writes=0,upgrades=0;
 const server=http.createServer((req,res)=>{if(req.method!=='GET'){writes++;res.writeHead(405).end();return;}res.setHeader('Content-Type','text/html').end(`<!doctype html><title>Mode SDK fixture</title><h1>Local workspace</h1><a href="/docs">Documentation</a><label>Sample<input id="sample"></label><button type="button" id="probe" onclick="fetch('/mutation',{method:'POST',body:'fixture'}).catch(()=>{});new WebSocket('ws://'+location.host+'/socket')">Probe nonpersistent request</button>`);});
 server.on('upgrade',(_req,socket)=>{upgrades++;socket.destroy();});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const url=`http://127.0.0.1:${server.address().port}/`,session={id:randomUUID(),mode,ownerUserId:'fixture',status:'idle',targetUrl:url,messages:[],activities:[],findings:[],todos:[],secretNames:[]};
 if(mode==='sqa')session.sqa=createSqaState({authorizationConfirmed:true,profiles:['core'],attributes:['web_application','user_interface'],target:{name:'Fixture',url,environment:'test',release:'test'}});
 else{session.founder=createFounderState({authorizationConfirmed:true,target:{name:'Fixture',url}});session.todos=createFounderReviewTodos();}
 const live={},store={liveFor:()=>live,listLive:()=>[],publish(){},async commit(){fs.writeFileSync(path.join(root,'checkpoint.json'),JSON.stringify(session));},async setStatus(s,status,detail){s.status=status;s.statusDetail=detail;},async addActivity(s,item){const activity={id:randomUUID(),ts:Date.now(),...item};s.activities.push(activity);if(process.env.QASE_MODE_TEST_TRACE==='true')console.log('mode-fixture',mode,composition,item.toolName,'start');return activity;},async updateActivity(s,id,patch){const item=s.activities.find(a=>a.id===id);Object.assign(item,patch);if(process.env.QASE_MODE_TEST_TRACE==='true')console.log('mode-fixture',mode,composition,item.toolName,patch.status);await this.commit();},async addMessage(s,item){s.messages.push(item);return item;}};
 await withUserConfiguration(settings,async()=>{},async()=>{
  const record=await ensureRuntime(session,store),nativeRun=record.runtime.run;let calls=0;
  t.after(async()=>{await record.bridge.service.dispose?.();record.dispose();deleteRunSnapshot(session.id);});
  record.runtime.cleanSlateService.chat=async(_messages,options)=>(async function*(){
   record.modeReasoning.usage({reservationId:options.qaseBudgetReservationId,callId:randomUUID(),inputTokens:10,outputTokens:10,estimated:false});
   calls++;
   if(calls===1){yield{type:'tool_call',call:{id:randomUUID(),toolName:'mode_discover_application',input:{}}};}
   else if(calls===2){
    assert.equal(modeDiscoveryStatus(session).ready,true);
    const feature=modeDiscoveryStatus(session).features.find(f=>f.kind==='surface');
    yield{type:'tool_call',call:{id:randomUUID(),toolName:'mode_plan_work',input:{workflows:[{id:'observed-review',title:'Review actual workspace',feature_ids:[feature.id],steps:['Inspect actual rendered workspace'],expected_behavior:'Workspace has visible semantic controls',control_ids:mode==='sqa'?['SQA-TRC-002']:undefined}]}}};
   }else if(calls===3&&composition){yield{type:'tool_call',call:{id:randomUUID(),toolName:'mode_run_workflow',input:{id:'observed-review',url,checks:['accessibility'],steps:[{tool:'browser_fill',input:{selector:'textarea',value:'Not dispatched'}}]}}};}
   else if(calls===3){yield{type:'tool_call',call:{id:randomUUID(),toolName:'mode_start_workflow',input:{id:'observed-review'}}};}
   else if(calls===4&&composition){
    assert.equal(session[mode].execution.actions.some(a=>a.status==='uncertain'),false,'A field absent before dispatch must not strand the run as an uncertain mutation.');
    yield{type:'tool_call',call:{id:randomUUID(),toolName:'mode_run_workflow',input:{id:'observed-review',url,checks:['accessibility'],steps:[{tool:'browser_fill',input:{selector:'#sample',value:'Fixture'}},{tool:'browser_click',input:{selector:'#probe'}}]}}};
   }
   else if(calls===5&&composition){
    assert.equal(session[mode].execution.workflows[0].status,'passed');
    assert.equal(session[mode].execution.phase,'coverage_recovery');
    yield{type:'tool_call',call:{id:randomUUID(),toolName:'ask_question',input:{question:'The browser tools are not exposed; should the user override the completion gate?'}}};
    const feature=modeDiscoveryStatus(session).features.find(f=>f.kind==='surface');
    yield{type:'tool_call',call:{id:randomUUID(),toolName:'mode_plan_work',input:{workflows:[{id:'unfinished',title:'Additional observed work',feature_ids:[feature.id],steps:['A still-pending verification'],expected_behavior:'Requires actual execution'}]}}};
    yield{type:'tool_call',call:{id:randomUUID(),toolName:'mode_start_workflow',input:{id:'unfinished'}}};
   }
   else if(calls===4){
    for(const[toolName,input]of [['browser_open',{url}],['browser_click',{selector:'#probe'}],['browser_qa_check',{action:'inspect'}],['browser_snapshot',{}],['browser_diagnostics',{}]])yield{type:'tool_call',call:{id:randomUUID(),toolName,input}};
   }else if(calls===(composition?6:5)){
    assert.ok(session.activities.filter(a=>a.toolName.startsWith('browser_')&&a.status==='done').length>=3);
    const toolName=mode==='sqa'?'record_sqa_control':'record_founder_observation';
    const input=mode==='sqa'?{control_id:'SQA-WEB-001',status:'blocked',rationale:'Fixture observation; the complete rendering evidence contract remains unavailable',evidence:[{type:'test_result',summary:'Rendered local workspace and collected diagnostics'}]}:{category:'product_clarity',type:'strength',title:'Clear workspace heading',summary:'Local workspace is visibly named on the fixture page',confidence:'high'};
    yield{type:'tool_call',call:{id:randomUUID(),toolName,input}};
   }else yield{type:'text',content:'All work is done. The final report is complete.'};
  })();
  record.modeReasoning.wrapChat(record.runtime.cleanSlateService);
  await runTurn(session,{task:'Inspect the local fixture and record one bounded observation. Never pretend missing review work is complete.'},store);
  assert.equal(record.runtime.run,nativeRun);assert.equal(record.runtime.run,Object.getPrototypeOf(record.runtime).run);
  assert.ok(session[mode].observations.length>0);assert.equal(session[mode].finalizedAt,undefined);assert.equal(session.status,'interrupted');
  assert.equal(session.pendingQuestion,undefined,'An internal host tool-exposure question must not become a user decision.');
  assert.ok(session[mode].execution.segments>=3);assert.ok(calls<16);
  const browser=session.activities.filter(a=>a.toolName.startsWith('browser_'));
  assert.ok(browser.length>=3);
  if(composition){assert.equal(browser.filter(a=>a.status==='failed').length,1);assert.match(browser.find(a=>a.status==='failed').error,/No fill was dispatched/);}
  else assert.ok(browser.every(a=>a.status==='done'));
  assert.equal(writes,0,'Qualified public modes must block target HTTP writes.');
  assert.equal(upgrades,0,'Qualified public modes must block WebSocket upgrades.');
  assert.equal(session[mode].execution.workflows.at(-1).status,'running','Model prose must not close the actual unfinished workflow.');
  const durable=JSON.parse(fs.readFileSync(path.join(root,'checkpoint.json')));
  assert.equal(durable[mode].observations.length,session[mode].observations.length);
  assert.equal(durable[mode].execution.telemetry.reasoner.reservedTokens,0);
  assert.equal(record.modeReasoning.state.evidence.filter(e=>e.tool.startsWith('browser_')).every(e=>browser.some(a=>a.id===e.activityId)),true);
 });
});
