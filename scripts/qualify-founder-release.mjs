import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import { request } from 'playwright';
import { createSqaTestServer } from './sqa-test-runtime.mjs';
import { FOUNDER_CATEGORY_IDS } from '../server/founderService.js';
import { founderDraftProgress, FOUNDER_DRAFT_PROTOCOL, FOUNDER_REPORT_SECTIONS } from '../server/founderReportDraft.js';

// Explicit live-model opt-in, isolated account/state and a disposable target.
// No external app, saved customer run or account preference is modified.
const { values } = parseArgs({ options: {
	'env-file': { type:'string' }, 'output-dir': { type:'string' },
	'restart-during-report': { type:'boolean', default:false },
	'compact-fixture': { type:'boolean', default:false },
	'timeout-minutes': { type:'string', default:'15' }
} });
assert.ok(values['env-file'], 'Pass --env-file with the existing gateway environment path.');
const timeoutMs=Number(values['timeout-minutes'])*60_000;
assert.ok(Number.isFinite(timeoutMs)&&timeoutMs>=60_000&&timeoutMs<=900_000, 'Choose a timeout between 1 and 15 minutes.');
const envFile=path.resolve(values['env-file']);
const secrets=Object.entries(parse(await readFile(envFile,'utf8')))
	.filter(([key,value])=>/key|token|password|secret/i.test(key)&&value.length>=8).map(([,value])=>value);
const root=fileURLToPath(new URL('../',import.meta.url));
const directory=path.resolve(values['output-dir']??path.join(root,'test-results','founder-live-release',String(Date.now())));
await mkdir(directory,{recursive:true});
let writes=0;
const fixture=createServer((req,res)=>{
	if(req.method!=='GET'){writes++;res.writeHead(405).end();return;}
	const content=values['compact-fixture']?'<h1>Practice workspace for small remote teams</h1><p>Practice a repeatable team task without sending private work to a server. A subscription is a hypothesis; no commercial results are measured.</p><p>Instructions: enter a task name of at least two characters and save. Empty or one-character names are invalid.</p><form onsubmit="event.preventDefault();document.querySelector(\'output\').textContent=\'Local task saved\'"><label>Task name<input name="task" required minlength="2"></label><button>Save local task</button><output aria-live="polite"></output></form>'
		:req.url==='/pricing'?'<h1>Team practice pricing</h1><p>Sample offer: $19 per team per month for task practice and documentation. This is product copy, not evidence of sales.</p>'
		:req.url==='/docs'?'<h1>Practice documentation</h1><p>Choose a task, enter a name of at least two characters, and save locally. Empty or one-character names are invalid. A valid name displays Local task saved. No data is sent to a server.</p>'
		:req.url==='/practice'?'<h1>Practice a task</h1><form onsubmit="event.preventDefault();document.querySelector(\'output\').textContent=\'Local task saved\'"><label>Task name<input name="task" required minlength="2"></label><button>Save local task</button><output aria-live="polite"></output></form>'
		:'<h1>Practice workspace for small remote teams</h1><p>Discover and practice repeatable team tasks without sending private work to a server.</p><a href="/practice">Start practicing</a>';
	res.setHeader('Content-Type','text/html');
	res.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Team practice fixture</title><style>body{font:18px system-ui;max-width:60rem;margin:auto;padding:1rem}nav{display:flex;flex-wrap:wrap;gap:1rem}input,button{font:inherit;max-width:100%}</style><nav><a href="/">Home</a>${values['compact-fixture']?'<a href="/docs">Help</a>':'<a href="/docs">Documentation</a><a href="/pricing">Pricing</a><a href="/practice">Practice</a>'}</nav><main>${content}</main><footer>No account, contact, payment, media or external service is offered in this disposable fixture.</footer></html>`);
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const target=`http://127.0.0.1:${fixture.address().port}/`;
const runtime=await createSqaTestServer(path.join(directory,'runtime'),{authRequired:true,envFile});
const account={email:`founder-release-${Date.now()}@local.example`,password:`Controlled qualification ${randomUUID()}`,displayName:'Founder live qualification'};
let api,csrf,sessionId,finalSession;
const result={status:'running',startedAt:new Date().toISOString(),source:'local controlled Founder release fixture',fixture:values['compact-fixture']?'compact two-route':'four-route',target,modelBacked:true};
async function json(method,route,data){
	const response=await api.fetch(`/api${route}`,{method,headers:{Origin:runtime.base,...(!['GET','HEAD'].includes(method)&&csrf?{'X-CSRF-Token':csrf}:{})},...(data===undefined?{}:{data})});
	assert.ok(response.ok(),`${method} ${route} returned HTTP ${response.status()}.`);return response.json();
}
async function signIn(register=false){
	await json('POST',register?'/auth/register':'/auth/login',account);
	csrf=(await api.storageState()).cookies.find(c=>c.name==='qase_csrf')?.value;assert.ok(csrf);
}
async function scanSecrets(folder){
	for(const entry of await readdir(folder,{withFileTypes:true})){
		const file=path.join(folder,entry.name);
		if(entry.isDirectory())await scanSecrets(file);
		if(entry.isFile()){
			const bytes=await readFile(file);
			assert.ok(!secrets.some(secret=>bytes.includes(Buffer.from(secret))),`Configured credential appeared in artifact: ${path.relative(directory,file)}`);
		}
	}
}
try{
	await runtime.start();api=await request.newContext({baseURL:runtime.base,timeout:30_000});await signIn(true);
	const config=await json('GET','/config');assert.ok(config.ready&&config.hasApiKey,'Gateway configuration is not ready.');
	result.provider=config.provider;result.model=config.model;
	const environments=await json('GET','/environments?platform=windows&browserCode=chrome&limit=1000');
	const environment=environments.environments.find(e=>e.active&&e.deviceType==='desktop'&&e.browserSupport?.status==='supported');
	assert.ok(environment,'A local desktop Chrome environment is required.');
	const created=await json('POST','/founder/sessions',{
		setupVersion:1,authorizationConfirmed:true,accessDecision:'public_only',contextMode:'provided',
		environmentId:environment.envId,engine:'chromium',target:{name:'Team practice fixture',url:target},
		productContext:{stage:'Isolated MVP fixture',businessModel:'B2B subscription hypothesis',targetCustomer:'Small remote teams',primaryGoal:'Evaluate task discovery and practice',constraints:'Controlled public-only fixture. No customers, analytics, revenue or authentication were supplied.'}
	});
	sessionId=created.id;assert.equal(created.founder.scope.access.decision,'public_only');
	await json('POST',`/sessions/${sessionId}/message`,{text:`Review ${target}. This is an explicitly authorized public-only Founder qualification. ${values['compact-fixture']?'Inventory Home and Help. The task practice form is on Home.':'Inventory Home, Documentation, Pricing and Practice.'} Exercise the representative task flow using only local sample input, including invalid and valid validation, and inspect the result. Check responsive behavior and diagnostics. Record all 17 lenses, using not-observed boundaries for absent surfaces and explicit assumptions for commercial hypotheses. Complete the canonical host plan, then draft every report section and publish through the advertised tools. No accounts, credentials, customer/revenue metrics or external services exist or should be requested. Do not leave this origin.`});
	const began=Date.now();let previous,reportCheckpoint;
	while(Date.now()-began<timeoutMs){
		const current=await json('GET',`/sessions/${sessionId}`);
		const progress=founderDraftProgress(current);
		const next=JSON.stringify({status:current.status,observations:current.founder.observations.length,activities:current.activities.length,sections:progress.completed.length,nextSection:progress.next,inputTokens:current.tokenUsage?.inputTokens??0,finalized:Boolean(current.founder.finalizedAt)});
		if(next!==previous){console.log(next);previous=next;}
		assert.ok((current.tokenUsage?.inputTokens??0)<=750_000,'Qualification input-token acceptance ceiling reached.');
		if(current.pendingQuestion)throw new Error('Founder unexpectedly requested input for the fully scoped account-free fixture.');
		if(current.founder.finalizedAt&&current.status==='done'&&!current.running){finalSession=current;break;}
		if(['error','interrupted','awaiting_input'].includes(current.status)&&!current.running)throw new Error(`Live Founder ended as ${current.status}.`);
		if(values['restart-during-report']&&!reportCheckpoint&&progress.completed.length>0&&!current.founder.finalizedAt){
			await json('POST',`/sessions/${sessionId}/stop`);
			let stopped;
			for(let attempt=0;attempt<100;attempt++){
				stopped=await json('GET',`/sessions/${sessionId}`);if(!stopped.running)break;
				await new Promise(resolve=>setTimeout(resolve,200));
			}
			assert.equal(stopped.running,false,'The isolated run did not stop.');assert.equal(stopped.founder.finalizedAt,undefined);
			reportCheckpoint={input:structuredClone(stopped.founder.reportDraft.input),observations:structuredClone(stopped.founder.observations),tokenUsage:stopped.tokenUsage,browserActivities:stopped.activities.filter(a=>a.toolName?.startsWith('browser_')).length};
			await writeFile(path.join(directory,'interrupted-checkpoint.json'),JSON.stringify(stopped,null,2));
			await runtime.stop();await runtime.start();await signIn();
			const restored=await json('GET',`/sessions/${sessionId}`);
			assert.deepEqual(restored.founder.reportDraft,stopped.founder.reportDraft);assert.equal(founderDraftProgress(restored).intact,true);
			await json('POST',`/sessions/${sessionId}/message`,{text:'Continue this authorized Founder report from its saved draft. Browser investigation and public-only scope are complete. Write only the remaining advertised sections and publish the exact complete revision. Do not repeat saved sections or browser work.'});
			result.midReportRestart={status:'resumed',savedSections:Object.keys(reportCheckpoint.input)};
		}
		await new Promise(resolve=>setTimeout(resolve,2000));
	}
	assert.ok(finalSession,'Founder did not finalize within the configured deadline.');
	assert.equal(finalSession.founder.reportGeneration?.protocol,FOUNDER_DRAFT_PROTOCOL);
	assert.equal(founderDraftProgress(finalSession).intact,true);
	assert.deepEqual(founderDraftProgress(finalSession).completed,FOUNDER_REPORT_SECTIONS);
	assert.ok(FOUNDER_CATEGORY_IDS.every(id=>finalSession.founder.observations.some(o=>o.category===id&&o.evidence?.length)));
	assert.ok(finalSession.todos.every(t=>t.status==='completed'));
	assert.ok(finalSession.founder.report.recommendations.length>=3);
	assert.ok(finalSession.tokenUsage?.totalTokens>0,'Live model usage was not retained.');
	if(values['restart-during-report']){
		assert.ok(reportCheckpoint,'No partial report checkpoint was exercised.');
		for(const [section,value] of Object.entries(reportCheckpoint.input))assert.deepEqual(finalSession.founder.reportDraft.input[section],value);
		assert.deepEqual(finalSession.founder.observations,reportCheckpoint.observations);
		assert.equal(finalSession.activities.filter(a=>a.toolName?.startsWith('browser_')).length,reportCheckpoint.browserActivities,'Synthesis replayed browser work after restart.');
		assert.ok(finalSession.tokenUsage.inputTokens>=reportCheckpoint.tokenUsage.inputTokens);
		result.midReportRestart.status='passed';
	}
	const browser=finalSession.activities.filter(a=>a.toolName?.startsWith('browser_')&&a.status==='done');
	assert.ok(browser.some(a=>a.toolName==='browser_diagnostics'));
	assert.ok(browser.some(a=>['browser_fill','browser_click','browser_key'].includes(a.toolName)||a.toolName==='browser_qa_check'&&a.input?.action==='forms'),'Representative workflow was not executed.');
	assert.equal(writes,0,'The fixture received an unexpected HTTP mutation.');
	for(const extension of ['md','pdf']){
		const response=await api.get(`/api/sessions/${sessionId}/report.${extension}`);assert.equal(response.status(),200);
		const bytes=await response.body();assert.ok(bytes.length>1000);if(extension==='pdf')assert.equal(bytes.subarray(0,4).toString(),'%PDF');
		await writeFile(path.join(directory,`report.${extension}`),bytes);
	}
	await writeFile(path.join(directory,'session.json'),JSON.stringify(finalSession,null,2));
	await runtime.stop();await runtime.start();await signIn();
	const restored=await json('GET',`/sessions/${sessionId}`);
	assert.deepEqual(restored.founder.report,finalSession.founder.report);
	assert.deepEqual(restored.founder.reportDraft,finalSession.founder.reportDraft);
	assert.deepEqual(restored.tokenUsage,finalSession.tokenUsage);
	assert.equal(founderDraftProgress(restored).intact,true);
	for(const extension of ['md','pdf'])assert.equal((await api.get(`/api/sessions/${sessionId}/report.${extension}`)).status(),200);
	const stranger=await request.newContext({baseURL:runtime.base});
	try{
		assert.equal((await stranger.post('/api/auth/register',{data:{...account,email:`other-${Date.now()}@local.example`}})).status(),201);
		for(const route of [`/sessions/${sessionId}`,`/sessions/${sessionId}/report.md`,`/sessions/${sessionId}/report.pdf`])assert.equal((await stranger.get(`/api${route}`)).status(),404);
	}finally{await stranger.dispose();}
	Object.assign(result,{status:'passed',sessionId,observations:finalSession.founder.observations.length,sections:founderDraftProgress(finalSession).completed,recommendations:finalSession.founder.report.recommendations.length,browserActivities:browser.length,tokenUsage:finalSession.tokenUsage,exports:'passed',restartPersistence:'passed',crossAccountIsolation:'passed',fixtureWrites:writes});
}catch(error){
	result.status='failed';result.error=error.message;result.sessionId=sessionId;process.exitCode=1;
	if(sessionId&&api){
		await json('POST',`/sessions/${sessionId}/stop`).catch(()=>undefined);
		const stopped=await json('GET',`/sessions/${sessionId}`).catch(()=>undefined);
		if(stopped)await writeFile(path.join(directory,'session.json'),JSON.stringify(stopped,null,2));
	}
}finally{
	await api?.dispose();await runtime.stop();fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));
	result.finishedAt=new Date().toISOString();
	await writeFile(path.join(directory,'result.json'),`${JSON.stringify(result,null,2)}\n`);
	try{await scanSecrets(directory);result.credentialScan='passed';}
	catch(error){result.status='failed';result.credentialScan='failed';result.error=error.message;process.exitCode=1;}
	await writeFile(path.join(directory,'result.json'),`${JSON.stringify(result,null,2)}\n`);console.log(JSON.stringify({...result,directory},null,2));
}
