import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApplication } from '../server/app.js';
import { buildReportMarkdown } from '../server/report.js';

// Real dashboard + HTTP handlers, isolated in-memory storage and a stub model.
const sessions = new Map();
const turns = [];
const listeners = new Map();
const publish = (s, type, payload = {}) => { for (const listener of listeners.get(s.id) ?? []) listener({ type, sessionId:s.id, ts:Date.now(), ...payload }); };
const config = { provider:'custom', model:'dashboard-fixture', ready:true, hasApiKey:true, providers:['custom'], headless:true };
const tenantContext = { organizationId:randomUUID(), projectId:randomUUID(), actorUserId:randomUUID(), actorEmail:'fixture@example.test', actorName:'Fixture owner' };
const services = {
	tenantContext,
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
	secrets:{clear(){},names:()=>[],store:()=>[]}, reports:{buildMarkdown:buildReportMarkdown},
	agent:{ensureRuntime(){},async runTurn(s,options){turns.push({mode:s.mode,options});await services.runs.setStatus(s,'idle');},closeBrowser:async()=>{},getLiveState:()=>({running:false}),stop(){},invalidateIdleRuntimes:()=>({kept:0})},
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
const output = path.resolve('test-results','dashboard');fs.mkdirSync(output,{recursive:true});
const browser = await chromium.launch({executablePath:chromium.executablePath()});
const errors = [];
const checks = [];
const reportSources = {};
const screenshot = async (page, name) => {
	await page.locator('dialog[open]').evaluateAll(async dialogs=>Promise.all(dialogs.flatMap(dialog=>dialog.getAnimations().map(animation=>animation.finished.catch(()=>{})))));
	await page.screenshot({path:path.join(output,name)});
};
try {
	const page = await browser.newPage({viewport:{width:1440,height:1000}});
	page.on('pageerror',error=>errors.push(error.message));
	await page.goto(base);await page.locator('#entry-begin').click();
	await page.locator('#entry-experience').waitFor({state:'hidden'});
	if (!await page.locator('#qa-start').evaluate(dialog=>dialog.open)) await page.locator('#new-run').click();
	await page.locator('#qa-start[open]').waitFor();
	await page.locator('#qa-submit').click();assert.equal(sessions.size,0,'Empty URL cannot launch QA');
	await page.locator('#qa-target-url').fill('https://example.test/');
	await page.locator('#qa-device-select').selectOption('iphone-15-pro');
	await page.locator('#qa-device-landscape').check();
	await screenshot(page,'qa-launch.png');
	await page.locator('#qa-submit').click();await page.locator('#qa-start').waitFor({state:'hidden'});
	await page.waitForFunction(()=>document.querySelector('#chat-title')?.textContent?.includes('example.test'));
	assert.equal([...sessions.values()][0].device,'iphone-15-pro');assert.equal([...sessions.values()][0].deviceLandscape,true);
	checks.push('QA launcher validates URL and preserves selected mobile landscape profile');
	const qaSession = [...sessions.values()][0];
	streams.get(qaSession.id).end();
	qaSession.status = 'awaiting_input';
	qaSession.messages.push({id:randomUUID(),ts:Date.now(),role:'agent',text:'Report progress recovered from the saved session.'});
	await page.waitForFunction(()=>document.querySelector('#status-chip')?.textContent === 'waiting for you');
	await page.getByText('Report progress recovered from the saved session.',{exact:true}).waitFor();
	checks.push('EventSource reconnect reloads state missed during a disconnect');
	await page.locator('#new-sqa').click();await page.locator('#sqa-start[open]').waitFor();
	assert.equal(await page.locator('#sqa-submit').isDisabled(),true);
	for(const [id,value] of [['name','Fixture'],['release','1'],['environment','test'],['url','https://example.test/']]) await page.locator(`#sqa-target-${id}`).fill(value);
	await page.locator('#sqa-authorization').check();
	await screenshot(page,'sqa-launch.png');
	await page.locator('#sqa-submit').click();await page.locator('#sqa-start').waitFor({state:'hidden'});
	await page.locator('#tab-sqa').waitFor({state:'visible'});await page.locator('#tab-sqa').click();
	assert.ok([...sessions.values()].some(s=>s.mode==='sqa'&&s.sqa.scope.authorization.confirmed));
	checks.push('SQA scope authorization, launcher API, pending assessment panel');
	await page.locator('#new-founder').click();await page.locator('#founder-start[open]').waitFor();
	await page.locator('#founder-target-name').fill('Fixture');await page.locator('#founder-target-url').fill('https://example.test/');await page.locator('#founder-authorization').check();
	await screenshot(page,'founder-launch.png');
	await page.locator('#founder-submit').click();await page.locator('#founder-start').waitFor({state:'hidden'});
	await page.locator('#tab-founder').waitFor({state:'visible'});await page.locator('#tab-founder').click();
	assert.ok([...sessions.values()].some(s=>s.mode==='founder'&&s.founder.scope.authorization.confirmed));
	checks.push('Founder context, authorization, launcher API, pending review panel');
	await page.screenshot({path:path.join(output,'desktop.png')});
	for(const width of [768,390]) {
		await page.setViewportSize({width,height:844});
		assert.ok(await page.locator('#new-run').isVisible());assert.ok(await page.locator('#new-sqa').isVisible());assert.ok(await page.locator('#new-founder').isVisible());
		await page.locator('#new-sqa').click();await page.locator('#sqa-start[open]').waitFor();
		await screenshot(page,`sqa-${width}.png`);await page.locator('#sqa-cancel').click();
		checks.push(`Mode dock and SQA dialog usable at ${width}px`);
	}
	assert.equal((await fetch(`${base}/demo`)).status,404);assert.equal((await fetch(`${base}/readyz`)).status,200);
	checks.push('Production demo disabled and readiness reachable');
	// Replay only completed controlled qualification output if available.
	for(const mode of ['qa','sqa','founder']) {
		const candidate = fs.readdirSync('test-results').filter(name=>name.startsWith(`agent-${mode}-`)).map(name=>path.join('test-results',name,'session.json')).filter(file=>fs.existsSync(file)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs).find(file=>JSON.parse(fs.readFileSync(file)).status==='done');
		if(!candidate) continue;
		reportSources[mode] = candidate;
		const s=JSON.parse(fs.readFileSync(candidate));
		// Early qualification outputs predate fixture timestamp initialization.
		s.createdAt ??= s.messages[0]?.ts ?? s.activities[0]?.ts;
		s.updatedAt ??= s.activities.at(-1)?.ts ?? s.createdAt;
		sessions.set(s.id,s);
		const md=await fetch(`${base}/api/sessions/${s.id}/report.md`);assert.equal(md.status,200);assert.ok((await md.text()).length>200);
		const pdf=await fetch(`${base}/api/sessions/${s.id}/report.pdf`);assert.equal(pdf.status,200);assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
		checks.push(`${mode} completed model report exports through real Markdown and PDF HTTP routes`);
	}
	assert.deepEqual(errors,[]);assert.deepEqual([...new Set(turns.map(t=>t.mode))].sort(),['founder','qa','sqa']);
	console.log(JSON.stringify({passed:true,checks,pageErrors:errors,reportSources},null,2));
	fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed:true,checks,pageErrors:errors,reportSources},null,2));
} finally {await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
