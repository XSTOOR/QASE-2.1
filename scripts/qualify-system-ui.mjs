import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { createApplication } from '../server/app.js';
import { buildReportMarkdown } from '../server/report.js';

const { values } = parseArgs({ options: { 'launch-only': { type: 'boolean', default: false } } });
const launchOnly = values['launch-only'];
const environment = { envId:'ENV-UI-FIXTURE', active:true, platform:'windows', device:'Desktop', deviceType:'desktop', os:'Windows', osVersion:'11', browser:'Chrome', browserCode:'chrome', browserVersion:'151', executionType:'SIMULATED', executionProvider:'local', emulation:{ viewport:{width:1440,height:1000}, deviceScaleFactor:1, isMobile:false, hasTouch:false } };

// Real dashboard + HTTP handlers, isolated in-memory storage and a stub model.
const sessions = new Map();
const vaults = new Map();
const turns = [];
const listeners = new Map();
const publish = (s, type, payload = {}) => { for (const listener of listeners.get(s.id) ?? []) listener({ type, sessionId:s.id, ts:Date.now(), ...payload }); };
const config = { hybridQa:{enabled:true,qualified:true,available:true}, provider:'custom', model:'dashboard-fixture', ready:true, hasApiKey:true, providers:['custom'], headless:true };
const tenantContext = { organizationId:randomUUID(), projectId:randomUUID(), actorUserId:randomUUID(), actorEmail:'fixture@example.test', actorName:'Fixture owner' };
const services = {
	tenantContext,
	feedback: { async create(input){ return input; }, async get(){ return null; }, async list(){ return []; }, async update(){ return null; }, async remove(){ return null; }, async stats(){ return { total: 0, byCategory: {}, byStatus: {}, byRating: {} }; }, async forRun(){ return null; } },
	runs: {
		load(){}, async create(title = 'New test run', options = {}) { const s = {id:randomUUID(),title,mode:'qa',createdAt:Date.now(),updatedAt:Date.now(),status:'idle',messages:[],activities:[],findings:[],todos:[],secretNames:[],...options};sessions.set(s.id,s);return s; },
		get:id=>sessions.get(id), list:()=>[...sessions.values()], async delete(id){return sessions.delete(id);},
		async commit(s,type,payload){publish(s,type,payload);},
		async addMessage(s,item){const message={id:randomUUID(),ts:Date.now(),...item};s.messages.push(message);publish(s,'message',{message});return message;},
		async addActivity(s,item){const activity={id:randomUUID(),ts:Date.now(),...item};s.activities.push(activity);return activity;},
		async updateActivity(s,id,patch){Object.assign(s.activities.find(a=>a.id===id),patch);},
		async setStatus(s,status){s.status=status;publish(s,'status',{status});}
	},
	events:{publish,async subscribe(id,listener){await new Promise(resolve=>setTimeout(resolve,150));const group=listeners.get(id)??new Set();group.add(listener);listeners.set(id,group);return()=>group.delete(listener);}},
	configuration:{getPublic:()=>config,save:()=>config,testConnection:async()=>({ok:true,models:['dashboard-fixture']})},
	secrets:{clear(id){vaults.delete(id);},names:id=>Object.keys(vaults.get(id)??{}),store(id,fields){vaults.set(id,{...fields});return Object.keys(fields);}}, reports:{buildMarkdown:buildReportMarkdown},
	agent:{ensureRuntime(){},async runTurn(s,options){turns.push({mode:s.mode,options});await services.runs.setStatus(s,'idle');},closeBrowser:async()=>{},getLiveState:()=>({running:false}),stop(){},invalidateIdleRuntimes:()=>({kept:0})},
	environments: {
		seed(){}, async list(){ return [environment]; },
		async facets(){ return { total: 1, devices: [], osVersions: [], browsers: [] }; },
		async get(id){ return id===environment.envId ? environment : null; }, async create(){ return {}; }, async update(){ return null; },
		async availability(){ return { available: 0, busy: 0 }; }, async catalogVersion(){ return 'fixture'; }
	},
	bugs: { async list(){ return []; }, async get(){ return null; }, async create(input){ return input; }, async update(){ return null; }, async remove(){ return null; } },
	readiness:{check:async()=>({ready:true})}, lifecycle:{close:async()=>{}}
};
const application = createApplication({services,environment:{NODE_ENV:'production'}});
const server = await new Promise(resolve=>{const s=application.app.listen(0,'127.0.0.1',()=>resolve(s));});
const streams = new Map();
server.on('request', (request, response) => {
	const match = request.url.match(/^\/api\/sessions\/([^/]+)\/events$/);
	if (match) streams.set(match[1], response);
});
const base = `http://127.0.0.1:${server.address().port}`;
// Exercise the real preflight against this fixture, without external DNS/model access.
const targetUrl = `${base}/healthz`;
const output = path.resolve(process.env.QASE_SYSTEM_UI_OUTPUT||'test-results/system-mode-ui');fs.mkdirSync(output,{recursive:true});
// Current UI qualification: real handlers/assets/SSE and browser; injected
// execution services. Actual live-model evidence is replayed only for export.
const browser=await chromium.launch();const errors=[],checks=[];
let page;
const failedResponses=[];
try{
 page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('response',async response=>{if(response.status()>=400)failedResponses.push({path:new URL(response.url()).pathname,status:response.status(),error:await response.json().then(value=>value.error).catch(()=>undefined)});});
 await page.addInitScript(envId=>localStorage.setItem('qase.activeTestEnvironment',JSON.stringify({envId})),environment.envId);
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/profile',route=>route.fulfill({json:{email:'fixture@example.test',displayName:'Fixture owner',profile:{timezone:'Asia/Kolkata'}}}));
 await page.route('**/api/memory*',route=>route.fulfill({json:[]}));
 const seed=await services.runs.create('UI qualification workspace',{targetUrl,status:'idle'});
 await page.goto(`${base}/#/runs/${seed.id}`);await page.locator('#auth-gate').waitFor({state:'hidden'});
 await page.locator('#qa-start').waitFor({state:'hidden'});
 for(const mode of ['sqa','founder']){
  await page.locator(`#new-${mode}`).click();await page.locator(`#${mode}-start[open]`).waitFor();
  assert.equal(await page.locator(`#${mode}-submit`).isDisabled(),true);
  await page.locator(`#${mode}-target-url`).fill(targetUrl);
  if(mode==='sqa'){
   await page.locator('#sqa-customize > summary').click();
   await page.locator('#sqa-target-release').fill('integration-fixture');
   await page.locator('#sqa-target-environment').fill('isolated local fixture');
  }
  await page.locator(`#${mode}-authorization`).check();
  if(mode==='founder'){
   await page.locator('#founder-context-mode').selectOption('provided');
   assert.equal(await page.locator('#founder-submit').isDisabled(),true);
   for(const [id,value]of [['stage','Beta'],['business-model','Subscription'],['target-customer','Small product teams'],['primary-goal','Improve first-run completion']])await page.locator(`#founder-${id}`).fill(value);
   await page.locator('#founder-context-mode').selectOption('assumptions');
   assert.equal(await page.locator('#founder-business-fields').isHidden(),true);
   assert.equal(await page.locator('#founder-stage').evaluate(input=>input.required),false);
   await page.locator('#founder-context-mode').selectOption('provided');
  }
  await page.waitForFunction(mode=>!document.querySelector(`#${mode}-submit`).disabled,mode);
  await page.locator(`#${mode}-submit`).click();await page.locator(`#${mode}-start`).waitFor({state:'hidden'});
  await page.locator(`#tab-${mode}`).waitFor({state:'visible'});
  const session=[...sessions.values()].find(s=>s.mode===mode);assert.ok(session?.[mode].scope.authorization.confirmed);
  if(mode==='sqa'){
   assert.ok(['web_application','user_interface'].every(attribute=>session.sqa.scope.attributes.includes(attribute)),'Recommended website review must include its browser-app attributes.');
   assert.ok(['001','002','003','004','005','006'].every(suffix=>session.sqa.scope.applicableControlIds.includes(`SQA-WEB-${suffix}`)),'The six browser smoke controls must not disappear from the default scope.');
  }
  if(mode==='founder'){
   assert.equal(session.founder.scope.access.decision,'public_only');
   assert.equal(session.founder.scope.contextDecision.mode,'provided');
   assert.equal(session.founder.scope.productContext.targetCustomer,'Small product teams');
  }
  await page.reload();await page.locator(`#tab-${mode}`).waitFor({state:'visible'});
  assert.ok(new URL(page.url()).hash.includes('/runs/'));assert.ok(!new URL(page.url()).hash.endsWith('/results'));
  checks.push(`${mode}: launcher authorization, API creation, reload and retained run route`);
 }

 // Scope and context choices use the real HTTP handlers; no model is executed.
 await page.locator('#new-founder').click();
 await page.locator('#founder-target-url').fill(targetUrl);
 await page.locator('#founder-authorization').check();
 await page.locator('#founder-access').selectOption('authenticated');
 const beforeCredentials=turns.length;
 await page.locator('#founder-submit').click();
 await page.locator('.cred-form').waitFor();
 assert.equal(turns.length,beforeCredentials,'No browser/model turn starts before secure setup is answered.');
 const authenticated=[...sessions.values()].find(s=>s.pendingQuestion?.kind==='founder_launch_credentials');
 assert.ok(authenticated);assert.equal(authenticated.founder.scope.contextDecision.mode,'assumptions');
 await page.reload();await page.locator('.cred-form').waitFor();
 const password='Local Founder UI fixture password';
 await page.locator('.cred-form').getByLabel('Username or email',{exact:true}).fill('founder-fixture@example.invalid');
 await page.locator('.cred-form').getByLabel('Password',{exact:true}).fill(password);
 publish(authenticated,'question',{question:authenticated.pendingQuestion});
 await page.waitForFunction(()=>document.querySelector('.cred-form input[type="password"]')?.value.length>0);
 assert.equal(await page.locator('.cred-form').getByLabel('Password',{exact:true}).inputValue(),password,'A repeated question must preserve unsent values in the current vault form.');
 await page.getByRole('button',{name:'Store and continue',exact:true}).click();
 assert.equal(turns.length,beforeCredentials,'Native consent validation prevents dispatch.');
 assert.equal(vaults.has(authenticated.id),false);
 await page.locator('.cred-form input[type="checkbox"]').check();
 await page.getByRole('button',{name:'Store and continue',exact:true}).click();
 await page.locator('.cred-form').waitFor({state:'hidden'});
 assert.equal(turns.length,beforeCredentials+1);
 assert.match(turns.at(-1).options.task,/\{\{QA_PASSWORD\}\}/);
 assert.ok(!JSON.stringify({sessions:[...sessions.values()],turns}).includes(password));
 checks.push('founder: authenticated setup survives reload, waits for consent and vault storage, then starts once with placeholders only');

 await page.locator('#new-founder').click();
 await page.locator('#founder-target-url').fill(targetUrl);
 await page.locator('#founder-authorization').check();
 await page.locator('#founder-access').selectOption('authenticated');
 await page.locator('#founder-submit').click();await page.locator('.cred-form').waitFor();
 const skipped=[...sessions.values()].find(s=>s.pendingQuestion?.kind==='founder_launch_credentials');
 await page.getByRole('button',{name:'Skip login',exact:true}).click();
 await page.locator('.cred-form').waitFor({state:'hidden'});
 assert.equal(skipped.founder.scope.access.decision,'public_only');assert.equal(vaults.has(skipped.id),false);
 checks.push('founder: Skip login saves an early public-only boundary without storing credentials');

 // Restored selections can finish loading after all form inputs are complete.
 const delayed=await browser.newPage({viewport:{width:1440,height:1000}});
 delayed.on('pageerror',error=>errors.push(error.message));
 await delayed.route('**/api/profile',route=>route.fulfill({json:{email:'fixture@example.test',displayName:'Fixture owner',profile:{timezone:'Asia/Kolkata'}}}));
 await delayed.route('**/api/memory*',route=>route.fulfill({json:[]}));
 await delayed.addInitScript(envId=>localStorage.setItem('qase.activeTestEnvironment',JSON.stringify({envId})),environment.envId);
 let releaseDevice;
 const deviceReady=new Promise(resolve=>{releaseDevice=resolve;});
 await delayed.route(url=>url.pathname==='/api/environments',async route=>{await deviceReady;await route.continue();});
 try{
  await delayed.goto(`${base}/#/runs/${seed.id}`);
  await delayed.locator('#new-founder').click();
  await delayed.locator('#founder-target-url').fill(targetUrl);
  await delayed.locator('#founder-authorization').check();
  assert.equal(await delayed.locator('#founder-submit').isDisabled(),true);
  assert.match(await delayed.locator('#founder-launch-status').textContent(),/choose a device and browser/);
  releaseDevice();
  await delayed.waitForFunction(()=>!document.querySelector('#founder-submit').disabled);
  await delayed.locator('#founder-target-url').fill('not-a-url');
  assert.equal(await delayed.locator('#founder-submit').isDisabled(),true);
  await delayed.locator('#founder-target-url').fill(targetUrl);
  await delayed.waitForFunction(()=>!document.querySelector('#founder-submit').disabled);
  await delayed.screenshot({path:path.join(output,'founder-setup-desktop.png')});
  await delayed.setViewportSize({width:390,height:844});
  assert.ok(await delayed.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.ok(await delayed.locator('#founder-launch-status').evaluate(node=>{
   const bounds=node.getBoundingClientRect();return bounds.width>0&&bounds.height>0&&bounds.left>=0&&bounds.right<=innerWidth&&bounds.top>=0&&bounds.bottom<=innerHeight;
  }),'The launch-readiness message must remain visible beside the submit actions on mobile.');
  await delayed.screenshot({path:path.join(output,'founder-setup-mobile.png')});
  checks.push('founder: invalid URL and missing device block launch; delayed device restoration enables it on desktop/mobile');
 }finally{releaseDevice();await delayed.close();}

 for(const mode of launchOnly?[]:['qa','sqa','founder']){
  const file=path.resolve(process.env.QASE_SYSTEM_QUALIFICATION_OUTPUT||'test-results/system-qualification',mode,'checkpoint.json');
  const session=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(session.status,'done');
  const finalTodos=session.todos;
  if(mode!=='qa')session.todos=finalTodos.map((todo,i)=>({...todo,status:i===finalTodos.length-1?'in_progress':todo.status}));
  session.createdAt??=session.messages[0]?.ts??session.activities[0]?.ts??Date.now();session.updatedAt??=session.createdAt;
  sessions.set(session.id,session);
  await page.goto(`${base}/#/runs/${session.id}`);
  await page.waitForFunction(()=>document.body.dataset.pageLoading!=='true');
  if(mode!=='qa'){
   const deadline=Date.now()+5000;
   while(!listeners.get(session.id)?.size){assert.ok(Date.now()<deadline,'UI event subscription must connect.');await new Promise(resolve=>setTimeout(resolve,10));}
   session.todos=finalTodos;
   publish(session,mode==='sqa'?'sqa':'founder.finalized',{todos:finalTodos,...(mode==='sqa'?{assessment:session.sqa.assessment,final:true}:{report:session.founder.report})});
   await page.waitForFunction(count=>document.querySelector('#count-plan')?.textContent===`${count}/${count}`,finalTodos.length);
   checks.push(`${mode}: atomic publication event completes the visible plan without page refresh`);
  }
  if(mode==='sqa')await page.locator('#tab-sqa').click();
  else if(mode==='founder')await page.locator('#tab-founder').click();
  else await page.locator('#tab-report').click();
  await page.reload();await page.waitForFunction(()=>document.body.dataset.pageLoading!=='true');
  assert.equal(new URL(page.url()).hash,`#/runs/${session.id}`);
  if(mode==='founder'){
   assert.equal(await page.locator('#report-view .founder-evidence-grid').evaluate(node=>getComputedStyle(node).display),'grid','Founder evidence metrics must retain their responsive grid.');
   for(const theme of ['light','dark']){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    assert.ok(await page.locator('#report-view .founder-hero h2').evaluate(node=>{
     const probe=document.createElement('span');probe.style.color='var(--text)';node.append(probe);
     const matches=getComputedStyle(node).color===getComputedStyle(probe).color;probe.remove();return matches;
    }),'Founder headings must use the active theme text color.');
   }
   await page.evaluate(()=>document.documentElement.dataset.theme='light');
   checks.push('founder: responsive evidence grid and readable light/dark heading palette');
  }
  const md=await page.request.get(`${base}/api/sessions/${session.id}/report.md`);assert.equal(md.status(),200);assert.ok((await md.text()).length>200);
  const pdf=await page.request.get(`${base}/api/sessions/${session.id}/report.pdf`);assert.equal(pdf.status(),200);assert.equal((await pdf.body()).subarray(0,5).toString(),'%PDF-');
  await page.screenshot({path:path.join(output,`${mode}-desktop.png`)});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.locator('body').isVisible());
  await page.screenshot({path:path.join(output,`${mode}-mobile.png`)});
  await page.locator('[data-workspace-view="results"]').click();
  await page.locator('#tab-report').click();
  await page.locator('#pane-report').waitFor({state:'visible'});
  assert.equal(new URL(page.url()).hash,`#/runs/${session.id}/results`,'Only the explicit Results action opens the results route.');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Mobile reports must not overflow the page.');
  await page.screenshot({path:path.join(output,`${mode}-mobile-report.png`)});
  await page.setViewportSize({width:1440,height:1000});
  checks.push(`${mode}: actual saved fixture report reload, Markdown/PDF HTTP exports, desktop/mobile render`);
 }
 assert.deepEqual(errors,[]);
 const result={passed:true,checks,pageErrors:errors,reportReplay:launchOnly?'not requested':'passed',execution:launchOnly?'Real launch handlers and SSE with injected execution; no live-model qualification':'Injected frontend services; reports from separately recorded live-model fixtures'};
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result,null,2));
}catch(error){
 const state=await page?.evaluate(()=>({route:location.hash,toasts:document.querySelector('#toasts')?.textContent,question:document.querySelector('#question-slot')?.textContent})).catch(()=>null);
 const result={passed:false,checks,pageErrors:errors,failedResponses,error:error.message,state,turns:turns.length};
 fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.error(JSON.stringify(result,null,2));
 await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw error;
}finally{for(const response of streams.values())if(!response.writableEnded)response.end();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
