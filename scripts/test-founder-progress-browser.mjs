import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {createSqaTestServer} from './sqa-test-runtime.mjs';
import {createFounderState,createFounderReviewTodos,FOUNDER_CATEGORY_IDS} from '../server/founderService.js';
import {createFounderDraftTool} from '../server/founderReportDraft.js';
import {founderReportToolSchema} from '../server/founderTools.js';
import {buildFounderProgress} from '../server/founderProgress.js';

const directory=path.resolve('test-results/integration/phase5-recovery-browser');await fs.mkdir(directory,{recursive:true});
const runtime=await createSqaTestServer(path.join(directory,'runtime'));
const id=randomUUID(),activities=['browser_open','browser_snapshot','browser_diagnostics'].map((toolName,i)=>({id:`evidence-${i}`,toolName,status:'done',ts:Date.now(),summary:'Controlled browser presentation fixture'}));
const session={id,mode:'founder',status:'interrupted',title:'Progress fixture',targetUrl:'https://fixture.test/',createdAt:Date.now(),updatedAt:Date.now(),messages:[],findings:[],secretNames:[],activities,
 todos:createFounderReviewTodos().map((t,i)=>({...t,status:i===7?'in_progress':'completed'})),
 founder:createFounderState({authorizationConfirmed:true,target:{name:'Progress fixture',url:'https://fixture.test/'},productContext:{stage:'Fixture',businessModel:'Hypothesis',targetCustomer:'Test teams',primaryGoal:'Test recovery UI'}})};
session.founder.reportGeneration={version:1,protocol:'section-draft-v1',evidenceHashVersion:1};
session.founder.observations=FOUNDER_CATEGORY_IDS.map((category,i)=>({id:`observation-${i}`,category,type:'opportunity',title:`Fixture ${category}`,summary:'Synthetic presentation state, not live qualification.',confidence:'low',evidence:activities.map(a=>({activityId:a.id}))}));
const draft=createFounderDraftTool(session,{async commit(){}},founderReportToolSchema());
assert.equal((await draft.run({section:'executive_summary',value:'Controlled progress presentation fixture.'})).success,true);
const progress=()=>buildFounderProgress(session);
let browser,page,posts=0,releasePost,postGate,simulateFailure=false;
const errors=[],checks=[];
const emit=event=>page.evaluate(data=>window.fixtureStream.onmessage({data:JSON.stringify(data)}),{sessionId:id,ts:Date.now(),...event});
try{
 await runtime.start();browser=await chromium.launch();page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.EventSource=class{constructor(){window.fixtureStream=this;setTimeout(()=>this.onopen?.(),0);}close(){}};});
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),pathname=url.pathname;
  if(request.method()==='POST'&&pathname===`/api/sessions/${id}/founder/continue`){
   posts++;assert.equal(request.postDataJSON().expectedCheckpoint,progress().recovery.token);
   if(simulateFailure)return route.fulfill({status:503,json:{error:'Fixture connection unavailable. Retry after checking it.'}});
   if(postGate)await postGate;
   session.status='running';return route.fulfill({status:202,json:{accepted:true,progress:progress()}});
  }
  assert.equal(request.method(),'GET','Only the explicitly intercepted recovery action may mutate the fixture.');
  const body=pathname==='/api/auth/me'?{id:'fixture',displayName:'Fixture owner'}
   :pathname==='/api/config'?{provider:'custom',model:'fixture',ready:true,hasApiKey:true,providers:['custom']}
   :pathname==='/api/devices'?{default:'desktop',devices:[{id:'desktop',label:'Desktop',kind:'desktop'}]}
   :pathname==='/api/sessions'?[session]
   :pathname===`/api/sessions/${id}`?{...session,founderProgress:progress()}
   :pathname===`/api/sessions/${id}/founder/progress`?progress()
   :pathname==='/api/founder/state'?{state:null}:undefined;
  if(body===undefined)await route.continue();else await route.fulfill({json:body});
 });
 async function open(){
  await page.goto(`${runtime.base}/#/runs/${id}`);
  await page.waitForFunction(()=>document.body.dataset.pageLoading!=='true'&&typeof window.fixtureStream?.onmessage==='function');
  await page.locator('#tab-founder').click();await page.locator('#founder-progress').waitFor({state:'visible'});
 }
 await open();
 const action=page.locator('#founder-progress [data-founder-continue]');
 await page.getByRole('button',{name:'Continue report',exact:true}).waitFor();
 assert.match(await page.locator('.founder-progress-counts').textContent(),/1\/11 report sections/);
 await action.focus();await page.evaluate(()=>{window.originalProgressButton=document.querySelector('[data-founder-continue]');window.originalProgressHeading=document.querySelector('#founder-progress-title');});
 await emit({type:'activity',activity:{id:'draft-display',toolName:'draft_founder_report_section',status:'done',label:'Saved report section',ts:Date.now()}});
 await page.waitForTimeout(300);
 assert.ok(await page.evaluate(()=>document.activeElement===window.originalProgressButton&&document.querySelector('[data-founder-continue]')===window.originalProgressButton));
 checks.push('Evidence refresh preserves the mounted keyboard control and focus.');
 postGate=new Promise(resolve=>{releasePost=resolve;});
 await action.press('Enter');await page.waitForFunction(()=>document.querySelector('[data-founder-continue]')?.disabled);
 await page.locator('#resume-run').click();
 await page.waitForTimeout(200);assert.equal(posts,1,'Header and panel recovery must share one request.');
 assert.ok(await page.evaluate(()=>document.activeElement===window.originalProgressHeading||document.activeElement.id==='resume-run'));
 releasePost();postGate=undefined;
 await page.locator('#founder-progress .founder-progress-state').filter({hasText:'Writing report'}).waitFor();assert.equal(posts,1);
 checks.push('Keyboard and header continuation coalesce; pending controls cannot dispatch duplicate requests.');
 session.status='interrupted';simulateFailure=true;
 await emit({type:'status',status:'interrupted',detail:'Stopped by user.'});
 await action.waitFor({state:'visible'});await action.focus();await action.press('Enter');
 await page.locator('.founder-progress-error').getByText(/Fixture connection unavailable/).waitFor();
 assert.ok(await page.locator('.founder-progress-error').evaluate(node=>document.activeElement===node));
 assert.equal(await action.isEnabled(),true);checks.push('A failed continuation shows an inline error, preserves progress and allows retry.');
 simulateFailure=false;
 assert.equal((await draft.run({section:'icp',value:{primary:'Fixture teams',users:['Team members'],buyers:['Team leads'],jobs:['Practice tasks'],pains:['Unclear next step'],evidence_observation_ids:['observation-0'],assumptions:[]}})).success,true);
 await page.reload();await page.waitForFunction(()=>document.body.dataset.pageLoading!=='true');await page.locator('#tab-founder').click();
 await page.waitForFunction(()=>document.querySelector('.founder-progress-counts')?.textContent.includes('2/11 report sections'));
 checks.push('Reload restores saved section counts without treating a partial draft as published.');
 await page.screenshot({path:path.join(directory,'desktop.png')});
 await page.setViewportSize({width:390,height:844});await page.locator('[data-workspace-view="results"]').click();await page.locator('#tab-founder').click();
 await action.scrollIntoViewIfNeeded();assert.ok((await action.boundingBox()).height>=44);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false);
 await page.screenshot({path:path.join(directory,'mobile.png')});checks.push('Mobile recovery has a 44px target and no horizontal overflow.');
 session.pendingQuestion={toolCallId:randomUUID(),credentialLike:true,kind:'founder_launch_credentials',question:'Provide a test account or choose Skip login.'};session.status='awaiting_input';
 await emit({type:'question',question:session.pendingQuestion});await emit({type:'status',status:'awaiting_input'});
 await page.locator('#founder-progress .founder-progress-state').filter({hasText:'Test account needed'}).waitFor();assert.equal(await action.isVisible(),false);
 await page.getByRole('button',{name:'Answer current question',exact:true}).click();await page.locator('.cred-form').waitFor({state:'visible'});
 await page.locator('[data-workspace-view="results"]').click();await page.locator('#tab-founder').click();
 checks.push('An unanswered secure-account request offers its existing question flow and no continue shortcut.');
 session.pendingQuestion=undefined;session.status='interrupted';session.founder.execution={strategy:'qualified-opus-jev-v1',reportProtocol:'section-draft-v1',evidenceHashVersion:1,telemetry:{reasoner:{reservedTokens:10}},actions:[]};delete session.founder.reportGeneration;
 await emit({type:'question',question:undefined});await emit({type:'status',status:'interrupted'});
 await page.locator('#founder-progress .founder-progress-state').filter({hasText:'Provider usage needs reconciliation'}).waitFor();assert.equal(await action.isVisible(),false);
 assert.equal(await page.locator('#resume-run').isDisabled(),true);
 await page.getByRole('button',{name:'View saved activity',exact:true}).click();assert.equal(await page.locator('#tab-activity').getAttribute('aria-selected'),'true');
 checks.push('Unverified usage blocks both recovery controls while retaining the saved report count.');
 assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(directory,'result.json'),JSON.stringify({status:'passed',modelCalls:0,checks,pageErrors:errors},null,2));
 console.log(JSON.stringify({status:'passed',modelCalls:0,checks,pageErrors:errors},null,2));
}catch(error){
 if(page){await page.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});const layout=await page.evaluate(()=>Object.fromEntries(['#tab-founder','#founder-progress-title','#founder-progress','.tabs','.tab-body','.viewer'].map(selector=>{const node=document.querySelector(selector),style=node&&getComputedStyle(node),r=node?.getBoundingClientRect();return [selector,node?{x:r.x,y:r.y,width:r.width,height:r.height,display:style.display,position:style.position,overflow:style.overflow,zIndex:style.zIndex,gridRows:style.gridTemplateRows}:null];}))).catch(()=>null);await fs.writeFile(path.join(directory,'failure-layout.json'),JSON.stringify(layout,null,2));}
 throw error;
}finally{releasePost?.();await browser?.close();await runtime.stop();}
