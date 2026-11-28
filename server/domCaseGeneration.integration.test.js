import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import express from 'express';
import { createTestCaseRoutes } from './testCaseApi.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { inspectCaseControls, publicRoute } from './qa/domCaseEvidence.js';
import { formOutcomeObserver } from './qa/formOutcome.js';
import { replayDomCase } from './qa/domCaseReplay.js';
import { domScenarios, duplicates, generateDomCases } from './domCaseGenerator.js';
import { createTestCaseService, createLocalTestCaseBackend } from './testCaseService.js';
import { createTestCaseAutogen } from './testCaseAutogen.js';
import { runQaEngine } from './qa/engine.js';
import { hybridStorage, hydrateHybrid } from './hybridPersistence.js';
import { qaModelSettings } from './qa/models.js';

const settings = { enabled:true,maxCases:50,domBatchSize:16,llmTimeoutMs:2000 };
const reviewer = {role:'owner',userId:'fixture-reviewer'};
const offline = {reasonerAvailable:() => false};
const store = async () => {
	const stateDir = await mkdtemp(path.join(tmpdir(),'qase-dom-'));
	return createTestCaseService(createLocalTestCaseBackend({stateDir}));
};
const fixture = '<title>Review</title><h1>Notes</h1><form method="post" action="/notes"><label>Name<input required name="name"></label><button>Save</button><output role="status"></output></form>' +
	'<form><input type="email" required aria-label="Email"><input type="password" required value="private-fixture-canary"><input type="number" min="2" max="7"><input type="date" min="2026-01-01"><input minlength="2" maxlength="8"><input pattern="[0-9]{3}">' +
	'<select><option>One</option><option>Two</option></select><input type="checkbox"><input type="radio"><button disabled>Continue</button></form><a href="/help">Help</a><button aria-expanded="false">Menu</button>' +
	'<button type="button">Unlisted private customer</button><script>document.forms[0].onsubmit=async e=>{e.preventDefault(); const f=e.target; const r=await fetch(f.action,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:f.elements.name.value})});const v=await r.json();f.querySelector("output").textContent="Saved reference: "+v.id;};</script>';

test('inspected Chromium evidence through generation, review, execution, UI and source changes', {timeout:90000}, async t => {
	let submissions = 0;
	const apiApp = express();
	apiApp.use(express.json());
	apiApp.use((req,_res,next) => {req.auth = reviewer; next();});
	const server = http.createServer(async (req,res) => {
		if (req.url.startsWith('/api/')) return apiApp(req,res);
		if (req.method === 'POST' && req.url === '/notes') {
			submissions++;
			res.setHeader('Content-Type','application/json'); return res.end(JSON.stringify({id:'fixture-'+submissions}));
		}
		if (['/testCaseView.js','/devicePicker.js'].includes(req.url)) {
			res.setHeader('Content-Type','text/javascript'); return res.end(await readFile(new URL('../public'+req.url,import.meta.url)));
		}
		res.setHeader('Content-Type','text/html');
		res.end(req.url === '/help' ? '<h1>Help</h1>' : fixture);
	});
	await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
	t.after(() => {server.closeAllConnections();server.close();});
	const origin = 'http://127.0.0.1:'+server.address().port;
	const browser = await chromium.launch();
	t.after(() => browser.close());
	const page = await browser.newPage();
	await page.goto(origin);
	const p = await inspectCaseControls(page);
	assert.ok(p.elements.length >= 14);
	for (const e of p.elements) assert.ok(await page.locator(e.css).evaluate((node,x) => node === document.evaluate(x, document,null,9,null).singleNodeValue,e.xpath));
	for (const text of ['private-fixture-canary','Unlisted private customer']) assert.ok(!JSON.stringify(p).includes(text));
	assert.equal(publicRoute(origin + '/notes?private=value'),null);
	assert.equal(publicRoute(origin + '/customer-identifier'),null);
	const observer = formOutcomeObserver(page,async () => 'fixture-receipt');
	const submit = page.getByRole('button',{name:'Save'});
	await observer.observe(submit,()=>submit.click());
	await page.locator('input[name=name]').fill('qa-fixture');
	await observer.observe(submit,()=>submit.click());
	assert.ok(observer.outcomes[0]?.receipt);
	await page.getByRole('link',{name:'Help'}).click();
	assert.equal(await page.locator('h1').innerText(),'Help');
	const session = {id:'source-run',status:'done',hybrid:{pageReview:{pages:[{path:'/'}],journey:{status:'passed',control:'Help',expected:'/help',actual:new URL(page.url()).pathname}}},
		report:{qaEngine:{formOutcomes:observer.outcomes,domCaseEvidence:{pages:[p],gaps:[],projectId:'fixture-project'}}}};
	const catalogue = domScenarios(session);
	assert.deepEqual([...new Set(catalogue.map(s => s.category))].sort(),['boundary','edge','functional','negative','positive','validation']);
	const testCases = await store();
	createTestCaseRoutes({testCases, runs:{get:async id=>id === session.id ? session : null},onError:(_req,res)=>res.sendStatus(500)})(apiApp);
	apiApp.get('/api/environments',(_req,res)=>res.json({environments:[]}));
	apiApp.get('/api/sessions',(_req,res)=>res.json([]));
	const manual = await testCases.create({title:'Existing manual test'});
	const requests = [];
	const engine = createTestCaseAutogen({testCases,settings,environment:{QASE_REASONER_MODEL:'fixture-reasoner', QASE_REASONER_API_KEY:'test-only'},config:{},
		fetchImpl:async (_,req) => {
			const payload = JSON.parse(req.body);
			const observations = JSON.parse(payload.messages[1].content);
			requests.push(observations);
			return Response.json({choices:[{message:{content:JSON.stringify({cases:observations.map(s => ({id:s.id,priority:'medium'}))})}}]});
		}});
	const result = await engine.generateForSession(session);
	assert.equal(result.status,'Completed',JSON.stringify(result.issues));
	assert.equal(result.created.length,catalogue.length);
	t.diagnostic('Fixture produced ' + result.created.length + ' cases across ' + requests.length + ' model batches.');
	assert.equal(new Set(result.created.map(c=>c.caseNumber)).size,result.created.length);
	assert.ok(requests.length > 1 && requests.every(batch => batch.length <= 16));
	assert.ok(!JSON.stringify(requests).includes('private-fixture-canary'));
	const caseFor = objective => result.created.find(c => c.generation.objective === objective);
	const malformed = caseFor('Malformed email');
	assert.equal(malformed.generation.model,'fixture-reasoner');
	assert.equal(malformed.generation.projectId,'fixture-project');
	const run = (c,opts={}) => replayDomCase({record:c,page,...opts});
	const review = (c,decision='approve') => testCases.review(c.caseNumber,{decision,version:c.generation.version},reviewer);
	const resolve = c => testCases.resolveForRun(c.caseNumber,null,reviewer);
	await assert.rejects(resolve(malformed),/approval/);
	await assert.rejects(testCases.review(malformed.caseNumber,{decision:'approve',version:1},{role:'pilot'}),/reviewer/);
	const ready = await review(malformed);
	await assert.rejects(review(malformed),/Refresh/);
	await assert.rejects(testCases.resolveForRun(ready.caseNumber,null,{role:'pilot'}),/permission/);
	assert.equal((await resolve(ready)).caseNumber,ready.caseNumber);
	await page.goto(origin);
	assert.equal((await run(ready)).status,'passed');
	for (const objective of ['Below minlength','Above maxlength','Digit pattern mismatch','Outside max','At min','Unicode text input','Choose an available option','Select native control']) {
		const record=await review(caseFor(objective));
		const checked=await run(record);
		assert.equal(checked.status,'passed',objective + ' ' + checked.detail);
	}
	const edited = await testCases.update(ready.caseNumber,{expected:'Owner-supplied acceptance criterion',version:2});
	assert.equal(edited.generation.original.expected,'typeMismatch is true.');
	assert.equal(edited.generation.reviewStatus,'Modified');
	const confirmed = await review(edited);
	assert.equal(confirmed.generation.expectationSource,'Confirmed Requirement');
	assert.equal((await run(confirmed)).status,'inconclusive');
	const unknown = caseFor('Clarify button outcome');
	await assert.rejects(review(unknown),/explicit expected/);
	assert.equal((await review(unknown,'reject')).generation.reviewStatus,'Rejected');
	const workflow = await review(caseFor('Repeat verified form submission'));
	assert.ok(workflow.generation.related.length > 0 && workflow.generation.artifactId);
	const before = submissions;
	assert.equal((await run(workflow)).status,'inconclusive');
	assert.equal(submissions,before);
	const replayPage = await browser.newPage();
	await replayPage.goto(origin);
	const saved = await run(workflow,{page:replayPage,allowWrites:true,writeOrigins:[origin]});
	assert.equal(saved.status,'passed',saved.detail);
	await replayPage.close();
	assert.equal(submissions,before+1);
	const link = await review(caseFor('Repeat verified navigation'));
	assert.equal((await run(link)).status,'passed');
	const duplicateRun = await engine.generateForSession(session);
	assert.equal(duplicateRun.created.length,0);
	assert.equal(duplicateRun.duplicates.length,catalogue.length);
	t.diagnostic('Repeat produced ' + duplicateRun.duplicates.length + ' exact duplicates and zero new records.');
	const candidate = catalogue.find(s=>s.objective==='Malformed email');
	assert.equal(duplicates(candidate,[{title:'Verify invalid email address',caseNumber:'another'}]).kind,'Potential Duplicate');
	assert.equal(duplicates(candidate,[{title:candidate.title,expected:'another expectation',caseNumber:'manual'}]).kind,'Potential Duplicate');
	assert.equal(duplicates(candidate,[{title:'Other assertion',generation:{element:candidate.element},caseNumber:'other'}]).kind,'Related Scenario');
	assert.deepEqual(await testCases.get(manual.caseNumber),manual);
	await t.test('a reviewed browser case publishes its actual verdict through the QA engine',async () => {
		const record = await review(caseFor('Empty required field'));
		const job = {id:'replay',mode:'qa',engine:'chromium',device:'desktop',targetUrl:p.url,testCaseSnapshot:record,activities:[],messages:[],todos:[],findings:[]};
		const runStore = {async commit(){},async addActivity(_,a){job.activities.push(a);return a;},async updateActivity(){},async addMessage(_,m){job.messages.push(m);},async setStatus(_,s){job.status=s;}};
		await runQaEngine({session:job,env:{QASE_BROWSER_ALLOWED_PRIVATE_HOSTS:'127.0.0.1',QASE_AGENT_CURSOR:'false'},runStore,record:{},settings:qaModelSettings({},{}), artifactStore:{save:()=>({artifactId:'fixture-image'})}});
		assert.equal(job.status,'done');
		assert.equal(job.report.qaEngine.domCaseExecution.caseNumber,record.caseNumber);
		assert.equal(job.report.verdict,'pass',job.report.summary);
		const reloaded={mode:'qa',report:{summary:job.report.summary}};
		hydrateHybrid(reloaded,JSON.parse(hybridStorage(job)));
		assert.deepEqual(reloaded.testCaseSnapshot,JSON.parse(JSON.stringify(job.testCaseSnapshot)));
		assert.equal(reloaded.report.qaEngine.domCaseExecution.status,'passed');
	});
	await t.test('Test Cases table exposes pending state and the review action enables Run',async () => {
		const selected=caseFor('Well-formed email');
		await page.goto(origin);

		await page.evaluate(async () => {
			const {createTestCaseView}=await import('/testCaseView.js');
			document.body.innerHTML='<dialog><table><tbody></tbody></table></dialog>';
			const api = async (url,init) => {const res=await fetch('/api'+url,{...init,headers:{'Content-Type':'application/json'}});if(!res.ok)throw Error('HTTP '+res.status);return res.json();};
			const view=createTestCaseView({api,toast:()=>{},fail:e=>{throw e;},elements:{dialog:document.querySelector('dialog'),list:document.querySelector('tbody')}});
			view.open();
		});
		const row=page.getByRole('row').filter({has:page.getByText(selected.caseNumber,{exact:true})});
		const button=row.getByRole('button',{name:'Run',exact:true});
		await button.waitFor();
		assert.ok(await button.isDisabled());
		await row.locator('summary').click();
		await row.getByRole('button',{name:'View source inspection'}).click();
		assert.ok((await row.locator('pre').innerText()).includes(selected.generation.element.fingerprint));
		await row.getByRole('button',{name:'Approve for execution'}).click();
		await row.locator('.tc-run:enabled').waitFor();
	});
	await page.goto(origin);
	await page.locator('input[type=email]').evaluate(e=>e.required=false);
	await page.evaluate(()=>{const host=document.createElement('div'); document.body.append(host);host.attachShadow({mode:'open'}).innerHTML='<button>Private</button>';document.body.append(document.createElement('iframe'));for(let i=0;i<175;i++)document.body.append(document.createElement('input'));});
	const changed=await inspectCaseControls(page);
	assert.ok(changed.truncated && changed.frames && changed.shadowHosts);
	const next={...session,id:'later',report:{qaEngine:{domCaseEvidence:{pages:[changed]}}}};
	await generateDomCases({session:next,testCases,settings:{...settings,maxCases:1},models:offline});
	assert.ok((await testCases.get(confirmed.caseNumber)).generation.stale);
	assert.equal((await run(ready)).status,'inconclusive');
	await t.test('concurrent creation, version conflict, partial output and persistence failure', async () => {
		const fresh = await store();
		const args = {session,testCases:fresh,settings:{...settings,maxCases:3},models:offline};
		await Promise.all([generateDomCases(args),generateDomCases(args)]);
		const all = await fresh.list();
		assert.equal(new Set(all.map(c=>c.generation.key)).size,all.length);
		const c = all[0];
		const actions = await Promise.allSettled(['approve','reject'].map(decision=>fresh.review(c.caseNumber,{version:1,decision},reviewer)));
		assert.equal(actions.filter(r=>r.status==='fulfilled').length,1);
		const mixed = await generateDomCases({...args,testCases:await store(),models:{reasonerAvailable:()=>true,reasonerModel:'fixture',json:async()=>({cases:[{id:0,priority:'medium'},{id:-1}]})}});
		assert.equal(mixed.status,'Partially Completed');
		const failure = await generateDomCases({...args,testCases:{list:async()=>[],create:async()=>{throw Error('storage error');}}});
		assert.equal(failure.status,'Failed');
	});
	for (const [name,json] of [['invalid output',async()=>({cases:[{id:999,priority:'high',selector:'invented'}]})],['timeout',async()=>{throw new Error('timeout');}]]) {
		await t.test(name, async()=>{
			const fresh=await store();
			const result=await generateDomCases({session,testCases:fresh,models:{reasonerAvailable:()=>true,json},settings});
			assert.equal(result.status,'Failed');assert.equal(result.created.length,0);assert.ok(result.issues.length);
		});
	}
});
