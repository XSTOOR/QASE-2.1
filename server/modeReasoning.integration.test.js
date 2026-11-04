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

// Deterministic model fixtures exercise the installed SDK and real browser;
// these are integration regressions, not evidence of live gateway qualification.
for(const mode of ['sqa','founder'])test(`${mode}: native SDK batches persist browser evidence before dependent tools and final prose cannot publish`,{timeout:30000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qase-mode-sdk-'));
 const env={NODE_ENV:'development',QASE_ALLOW_PRIVATE_NETWORK:'true',QASE_LOCK_MODEL:'false',[`QASE_${mode.toUpperCase()}_REASONING_ENABLED`]:'true',QASE_HYBRID_QUALIFICATION_FILE:path.join(root,'qualification.json')};
 const saved=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
 t.after(()=>{for(const[key,value]of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;fs.rmSync(root,{recursive:true,force:true});});
 const settings={provider:'jev',baseUrl:JEV_ENDPOINT,model:'jev-1.13',apiKey:'fixture-only-mode-key',headless:true,maxTurns:2},profile=hybridProfile(settings);
 fs.writeFileSync(env.QASE_HYBRID_QUALIFICATION_FILE,JSON.stringify({sdkVersion:HYBRID_SDK_VERSION,profileIdentity:profileIdentity(profile),checkedAt:Date.now(),capabilities:Object.fromEntries(REQUIRED_CAPABILITIES.map(name=>[name,{passed:true}]))}));
 const server=http.createServer((_req,res)=>res.setHeader('Content-Type','text/html').end('<!doctype html><title>Mode SDK fixture</title><h1>Local workspace</h1><a href="/docs">Documentation</a>'));
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const url=`http://127.0.0.1:${server.address().port}/`,session={id:randomUUID(),mode,ownerUserId:'fixture',status:'idle',targetUrl:url,messages:[],activities:[],findings:[],todos:[],secretNames:[]};
 if(mode==='sqa')session.sqa=createSqaState({authorizationConfirmed:true,profiles:['core'],attributes:['web_application','user_interface'],target:{name:'Fixture',url,environment:'test',release:'test'}});
 else{session.founder=createFounderState({authorizationConfirmed:true,target:{name:'Fixture',url}});session.todos=createFounderReviewTodos();}
 const live={},store={liveFor:()=>live,listLive:()=>[],publish(){},async commit(){fs.writeFileSync(path.join(root,'checkpoint.json'),JSON.stringify(session));},async setStatus(s,status,detail){s.status=status;s.statusDetail=detail;},async addActivity(s,item){const activity={id:randomUUID(),ts:Date.now(),...item};s.activities.push(activity);return activity;},async updateActivity(s,id,patch){Object.assign(s.activities.find(a=>a.id===id),patch);await this.commit();},async addMessage(s,item){s.messages.push(item);return item;}};
 await withUserConfiguration(settings,async()=>{},async()=>{
  const record=await ensureRuntime(session,store),nativeRun=record.runtime.run;let calls=0;
  t.after(async()=>{await record.bridge.service.dispose?.();record.dispose();deleteRunSnapshot(session.id);});
  record.runtime.cleanSlateService.chat=async(_messages,options)=>(async function*(){
   record.modeReasoning.usage({reservationId:options.qaseBudgetReservationId,callId:randomUUID(),inputTokens:10,outputTokens:10,estimated:false});
   calls++;
   if(calls===1){
    for(const[toolName,input]of [['browser_open',{url}],['browser_snapshot',{}],['browser_diagnostics',{}]])yield{type:'tool_call',call:{id:randomUUID(),toolName,input}};
   }else if(calls===2){
    assert.equal(session.activities.filter(a=>a.toolName.startsWith('browser_')&&a.status==='done').length,3);
    const toolName=mode==='sqa'?'record_sqa_control':'record_founder_observation';
    const input=mode==='sqa'?{control_id:'SQA-TRC-002',status:'blocked',rationale:'Fixture observation; broader evidence remains unavailable',evidence:[{type:'test_result',summary:'Rendered local workspace and collected diagnostics'}]}:{category:'product_clarity',type:'strength',title:'Clear workspace heading',summary:'Local workspace is visibly named on the fixture page',confidence:'high'};
    yield{type:'tool_call',call:{id:randomUUID(),toolName,input}};
   }else yield{type:'text',content:'All work is done. The final report is complete.'};
  })();
  record.modeReasoning.wrapChat(record.runtime.cleanSlateService);
  await runTurn(session,{task:'Inspect the local fixture and record one bounded observation. Never pretend missing review work is complete.'},store);
  assert.equal(record.runtime.run,nativeRun);assert.equal(record.runtime.run,Object.getPrototypeOf(record.runtime).run);
  assert.ok(session[mode].observations.length>0);assert.equal(session[mode].finalizedAt,undefined);assert.equal(session.status,'interrupted');
  assert.ok(session[mode].execution.segments>=3);assert.ok(calls<12);
  const browser=session.activities.filter(a=>a.toolName.startsWith('browser_'));
  assert.equal(browser.length,3);assert.ok(browser.every(a=>a.status==='done'));
  const durable=JSON.parse(fs.readFileSync(path.join(root,'checkpoint.json')));
  assert.equal(durable[mode].observations.length,session[mode].observations.length);
  assert.equal(durable[mode].execution.telemetry.reasoner.reservedTokens,0);
  assert.equal(record.modeReasoning.state.evidence.filter(e=>e.tool.startsWith('browser_')).every(e=>browser.some(a=>a.id===e.activityId)),true);
 });
});
