// Isolated qualification workload using production mode tools, one real SDK
// reasoner and a loopback-only Chromium fixture. Never writes activation receipts.
import 'dotenv/config';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {CleanSlateNodeAgentRuntime, createNodeProviderConfiguration} from '@cleanslate/sdk';
import {chromium} from 'playwright';
import {getConfig} from '../server/config.js';
import {standaloneResearchProfile} from '../server/sqaStandaloneQualification.js';
import {createHybridUsageTransport} from '../server/hybridUsageTransport.js';
import {createModeReasoningRuntime} from '../server/modeReasoningRuntime.js';
import {modeDiscoveryStatus} from '../server/modeDiscovery.js';
import {createSqaResearch,standaloneResearchReadiness} from '../server/sqaResearch.js';
import {createSqaState} from '../server/sqaService.js';
import {SQA_STANDALONE_STRATEGY} from '../server/sqaStandaloneStrategy.js';
import {runJevBrowserCheck} from '../server/jevBrowserChecks.js';
import {researchMarkdown} from '../public/sqaResearchSections.js';
import {renderReportPdf} from '../server/reportPdf.js';

const fixture = process.argv.includes('--fixture');
if (!fixture) assert.equal(process.env.QASE_LIVE_SYSTEM_QUALIFICATION,'true');
assert.notEqual(process.env.NODE_ENV,'production');
const profile = standaloneResearchProfile(getConfig());
if (fixture) profile.reasoner.apiKey = 'isolated-scripted-reasoner';
assert.ok(profile.reasoner.apiKey,'No configured standalone reasoner credential.');
profile.executionStrategy=SQA_STANDALONE_STRATEGY;
profile.budgets.reasonerCalls=Math.min(profile.budgets.reasonerCalls,12);
const shortname=fixture?'fixture-1.0':'accname-1.1';
const official='https://www.w3.org/TR/'+shortname+'/';
const api='https://api.w3.org/specifications/'+shortname;
const edition=api+'/versions/20261118';
const title='Fixture Accessible Name Guidance';
const quote='Interactive form controls should expose their accessible names.';
const fixtureDocuments=new Map([
 [official,'<title>'+title+'</title><section id="control-names"><p>'+quote+'</p></section>'],
 [api,JSON.stringify({shortname,shortlink:official,title,'series-version':'1.0',_links:{'latest-version':{href:edition}}})],
 [edition,JSON.stringify({shortlink:official,title,uri:'https://www.w3.org/TR/2026/REC-'+shortname+'-20261118/',status:'Recommendation',date:'2026-11-18',_links:{self:{href:edition}}})]
]);
const url='http://127.0.0.1/fixture';
const runId=randomUUID(), started=Date.now();
const root=await mkdtemp(path.join(tmpdir(),'qase-sqa-sdk-'));
const output=path.resolve('.qase/validation',fixture?'sqa-development-fixture':'sqa-live-workflow',runId);
await mkdir(output,{recursive:true,mode:0o700});
const save=(name,data)=>writeFile(path.join(output,name),data,{mode:0o600});
let session={id:runId,mode:'sqa',targetUrl:url,activities:[],todos:[],messages:[],findings:[],createdAt:started,status:'running'};
session.sqa=createSqaState({authorizationConfirmed:true,profiles:['core'],target:{name:'Practice registration',release:'fixture',environment:'isolated',url}});
const record={}, trace=[];
const createHost=()=>createModeReasoningRuntime({session,profile,record,runStore:{async commit(){
	await save('checkpoint.tmp',JSON.stringify(session));await rename(path.join(output,'checkpoint.tmp'),path.join(output,'checkpoint.json'));
}}});
let host=createHost();
const summary={runId,output,execution:fixture?'development_fixture':'live_direct_source',scriptedModel:fixture,fixtureResearch:fixture,model:profile.reasoner.model,qualified:false,published:false,unexpectedDispatches:0,requests:0,responses:[]};
const deadline=AbortSignal.timeout(180000);
let browser,sdk,transport;
try{
	browser=await chromium.launch({headless:true});
	let page=await browser.newPage({serviceWorkers:'block'});
	const errors=[],failed=[];
	page.on('pageerror',e=>errors.push(e.message));
	page.on('requestfailed',r=>failed.push(r.url()));
	const intercept=page=>page.route('**/*',route=>route.request().url()===url && route.request().method()==='GET'
		?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><title>Practice registration</title><main><h1>Register for a demo</h1><form onsubmit="return false"><label for="nickname">Display name</label><input required id="nickname"><button type="button" id="unlabelled"></button></form></main></html>'})
		:route.abort());
	await intercept(page);
	const primitive={
		browser_get_url:async()=>({success:true,url:page.url()}),
		browser_open:async input=>{assert.equal(input.url,url);await page.goto(url);return {success:true,url:page.url()};},
		browser_qa_check:async(input,signal)=>{assert.ok(['inspect','accessibility','forms'].includes(input.action));return runJevBrowserCheck(page,input,{signal});},
		browser_snapshot:async()=>({success:true,url:page.url(),bodyText:await page.locator('body').innerText()}),
		browser_diagnostics:async()=>({success:true,url:page.url(),console:errors,network:failed})
	};
	record.onModeToolResult=async({toolCallId,result})=>{session.activities.find(a=>a.id===toolCallId).status=result?.success===false?'failed':'done';};
	record.invokeModeTool=async(name,input,signal)=>{
		assert.ok(Object.hasOwn(primitive,name),'Browser operation outside fixture contract');
		const activity={id:randomUUID(),toolName:name,ts:Date.now(),status:'running'};session.activities.push(activity);
		return host.withActivity(activity,()=>host.wrapTool({name,run:()=>primitive[name](input,signal)}).run(input,{signal}));
	};
	const names=new Set(['mode_discover_application','web_fetch','sqa_record_requirement','sqa_record_applicability','mode_plan_work','mode_run_workflow',...(fixture?['mode_verify_recovery']:[])]);
	const tools=host.tools.filter(t=>names.has(t.name)).map(tool=>({...tool,async run(input,ctx){
		if(tool.name==='web_fetch')assert.equal(input.url,official);
		const current=fixture && tool.name==='web_fetch'
   ? createSqaResearch({session,checkpoint:host.checkpoint,retrieve:async url=>{
    const content=fixtureDocuments.get(url);assert.ok(content,'Unexpected fixture research destination');
    return {url,finalUrl:url,content,retrievedAt:Date.now(),contentHash:createHash('sha256').update(content).digest('hex')};
   }}).find(candidate=>candidate.name===tool.name)
   : host.tools.find(candidate=>candidate.name===tool.name);
  const result=await host.wrapTool(current).run(input,ctx);
		trace.push({tool:tool.name,success:result.success,code:result.code,error:result.error,
   ...(tool.name==='web_fetch'?{offset:result.offset,sectionCount:result.sectionLocators?.length,windowLength:result.content?.length}:{}),
   ...(tool.name==='sqa_record_requirement'?{control:input.control_id,framework:input.framework,quote:input.quote?.slice(0,220)}:{})});
		return result;
	}}));
 const formFeature=()=>modeDiscoveryStatus(session).features.find(feature=>feature.kind==='forms').id;
 const script=[
  ()=>['mode_discover_application',{}],
  ()=>['web_fetch',{url:official}],
  ()=>['sqa_record_requirement',{source_id:host.state.research.sources[0].id,control_id:'control-names',framework:title,quote}],
  ()=>['sqa_record_applicability',{requirement_ids:[host.state.research.requirements[0].id],feature_ids:[formFeature()],classification:'RECOMMENDED',obligation:'recommended_practice',jurisdiction:'fixture',rationale:'Observed form controls',assumptions:[]}],
  ()=>['mode_plan_work',{workflows:[{id:'fixture-name-check',title:'Verify form control names',feature_ids:[formFeature()],applicability_id:host.state.research.applicability[0].id,steps:['Run the accessibility and form checks on the observed form'],expected_behavior:'Interactive form controls have accessible names'}]}],
  ()=>['mode_run_workflow',{id:'fixture-name-check',checks:['accessibility','forms']}],
  ()=>null,
  ()=>['mode_verify_recovery',{}],
  ()=>null
 ];
 function scriptedResponse(number, advertised){
  assert.ok(number<=script.length,'Unexpected scripted reasoning turn');
  const next=script[number-1]();
  if(next) assert.ok(advertised.some(tool=>tool.function?.name===next[0]),'Expected tool was not advertised: '+next[0]);
  const delta=next?{role:'assistant',tool_calls:[{index:0,id:'fixture-call-'+number,type:'function',function:{name:next[0],arguments:JSON.stringify(next[1])}}]}:{role:'assistant',content:'Development fixture segment complete.'};
  const chunks=[{choices:[{index:0,delta,finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:next?'tool_calls':'stop'}]},{choices:[],usage:{prompt_tokens:40,completion_tokens:15,total_tokens:55}}];
  return new Response(chunks.map(value=>'data: '+JSON.stringify({id:'fixture-'+number,object:'chat.completion.chunk',model:profile.reasoner.model,...value})+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
 }
	transport=await createHybridUsageTransport(profile,{onUsage:item=>host.usage(item),fetchImpl:async(u,opts)=>{
		if(u!==profile.reasoner.endpoint||JSON.parse(opts.body).model!==profile.reasoner.model){summary.unexpectedDispatches++;throw Error('Unexpected model dispatch');}
		summary.requests++;
  const response=fixture?scriptedResponse(summary.requests,JSON.parse(opts.body).tools??[]):await fetch(u,opts);
  summary.responses.push({status:response.status,eventStream:response.headers.get('content-type')?.includes('text/event-stream')===true});
  return response;
	}});
	const task='Assess the observed accessible names in the local practice form. First discover it. Then use the supplied primary W3C source '+official+' (a fixed input for this qualification), record a literal excerpt from the technical name-computation body with its observed section identifier. Use the abstract only as background, and record a voluntary applicability decision for the discovered form. Add a single research-linked workflow and run it with the accessibility and forms checks. Stop after the workflow has a verified disposition. Report limitations. Never infer certification.';
	sdk=new CleanSlateNodeAgentRuntime({rootPath:root,configuration:createNodeProviderConfiguration({provider:'custom',model:profile.reasoner.model,apiKey:transport.apiKey,baseUrl:transport.baseUrl,maxTurns:12}),
		approveTool:async({toolName})=>names.has(toolName),approveCommand:async()=>false,logger:{info(){},debug(){},warn(){},error(){}},additionalContext:task});
	sdk.headlessRuntime.options.tools=tools;sdk.headlessRuntime.toolsByName.clear();
	for(const tool of tools)sdk.headlessRuntime.toolsByName.set(tool.name,tool);
	assert.equal(host.tools.some(tool=>tool.name==='classify_mode_observations'),false);
	const originalChat=sdk.cleanSlateService.chat.bind(sdk.cleanSlateService);
	sdk.cleanSlateService.chat=transport.wrapChat(originalChat);
	host.wrapChat(sdk.cleanSlateService);
	await host.beginTurn(deadline);
	for await(const event of sdk.run(task,deadline)){deadline.throwIfAborted();}
	await host.endTurn('probe_finished');
 if (fixture) {
  assert.equal(host.state.workflows[0]?.status,'failed');
  const evidenceIds=[...host.state.workflows[0].evidenceIds];
  const priorUsage=host.state.telemetry.reasoner.calls;
  await page.close();
  page=await browser.newPage({serviceWorkers:'block'});
  await intercept(page);
  session=JSON.parse(await readFile(path.join(output,'checkpoint.json'),'utf8'));
  session.status='interrupted';
  host=createHost();
  assert.equal(host.state.recoveryRequired,true);
  sdk.clearConversation();
  // Attach the restored host to the same private scripted transport.
  sdk.cleanSlateService.chat=transport.wrapChat(originalChat);
  host.wrapChat(sdk.cleanSlateService);
  await host.beginTurn(deadline);
  for await(const event of sdk.run('Verify the new browser session and retain saved evidence.',deadline)){deadline.throwIfAborted();}
  assert.equal(host.state.recoveryRequired,false);
  assert.deepEqual(host.state.workflows[0].evidenceIds,evidenceIds);
  assert.equal(trace.filter(row=>row.tool==='mode_run_workflow').length,1);
  assert.ok(host.state.telemetry.reasoner.calls>priorUsage);
  assert.equal(host.state.recoveries.length,1);
  summary.checkpointRecovery=true;
  await host.endTurn('probe_finished');
 }
	const restored=JSON.parse(await readFile(path.join(output,'checkpoint.json'),'utf8'));
	const {ready,blockers,report}=standaloneResearchReadiness(restored);
 if (fixture) {
  report.validation='development_fixture';
  report.limitations=['Development fixture with scripted model responses and synthetic publisher metadata.',...report.limitations];
 }
	Object.assign(summary,{ready,blockers,metrics:report.metrics,sources:report.references.map(s=>({url:s.finalUrl,authority:s.authority})),trace});
	await save('research-progress.json',JSON.stringify(report,null,2));await save('research-progress.md',(fixture?'# Development fixture — scripted model and synthetic research\n\n':'# Unpublished qualification sample\n\n')+researchMarkdown(report));
	await page.screenshot({path:path.join(output,'observed-form.png')});
	// Exercise the production PDF serializer on the explicitly unpublished snapshot.
	const preview={...restored,sqa:{...restored.sqa,assessment:{...restored.sqa.assessment,verdict:fixture?'DEVELOPMENT FIXTURE — UNPUBLISHED':'unpublished fixture',researchReport:report}}};
	await save('research-preview.pdf',await renderReportPdf(preview));
	assert.ok(ready,blockers.join(' '));
	assert.ok(report.tests.some(t=>t.status==='failed' && t.observations.some(o=>o.assertions.some(a=>a.outcome==='fail'))),'Missing evidence of the unlabelled button.');
	assert.equal(host.state.telemetry.classifier.calls,0);
	assert.equal(summary.unexpectedDispatches,0);
	summary.samplePassed=true;
}catch(error){summary.error=String(error.message).slice(0,500).replaceAll(profile.reasoner.apiKey,'[redacted]');process.exitCode=1;}
finally{
	summary.trace=trace;summary.elapsedMs=Date.now()-started;summary.usage=host.state.telemetry.reasoner;
	await save('result.json',JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
	sdk?.dispose();transport?.dispose();await browser?.close();await rm(root,{recursive:true,force:true});
}
