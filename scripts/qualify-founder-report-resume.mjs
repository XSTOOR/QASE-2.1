/** Live report recovery from a completed, controlled browser investigation.
 * The source checkpoint is read-only; the candidate runs in isolated storage.
 * This qualifies synthesis, not a successful autonomous investigation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import { ensureRuntime, runTurn, deleteRunSnapshot, isFounderSynthesisReady } from '../server/agent.js';
import { platformEnvironment } from '../server/platformEnvironment.js';
import { getConfig, withUserConfiguration } from '../server/config.js';
import { buildFounderReportMarkdown } from '../server/founderService.js';
import { founderDraftProgress, FOUNDER_REPORT_SECTIONS, usesFounderDraft } from '../server/founderReportDraft.js';
import { renderReportPdf } from '../server/reportPdf.js';

const { values }=parseArgs({options:{'env-file':{type:'string'},checkpoint:{type:'string'},'output-dir':{type:'string'}}});
assert.ok(values['env-file']&&values.checkpoint,'Supply an existing gateway env path and a controlled Founder checkpoint.');
assert.notEqual(process.env.NODE_ENV,'production');
const source=path.resolve(values.checkpoint),sourceBytes=fs.readFileSync(source);
const session=JSON.parse(sourceBytes);
assert.equal(session.mode,'founder');assert.equal(session.founder.scope.target.name,'Team practice fixture');
assert.match(session.id,/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
assert.ok(['interrupted','error'].includes(session.status)&&!session.pendingQuestion);
assert.ok(!session.activities.some(a=>a.status==='running'));
assert.equal(session.founder.reportGeneration?.protocol,'section-draft-v1');
assert.ok(['127.0.0.1','localhost'].includes(new URL(session.targetUrl).hostname));
assert.equal(session.founder.scope.access.decision,'public_only');assert.equal(session.secretNames?.length||0,0);
assert.ok(usesFounderDraft(session)&&isFounderSynthesisReady(session)&&founderDraftProgress(session).intact);
assert.ok(session.founder.reportDraft,'A saved section is required to qualify restart recovery.');
const directory=path.resolve(values['output-dir']||'.');fs.mkdirSync(directory,{recursive:true});
const environment=parse(fs.readFileSync(path.resolve(values['env-file']),'utf8'));
const secrets=Object.entries(environment).filter(([key,value])=>/key|token|password|secret/i.test(key)&&value.length>=8).map(([,value])=>value);
Object.assign(process.env,platformEnvironment(environment,{}),{NODE_ENV:'development',QASE_FOUNDER_REASONING_ENABLED:'false',QASE_ALLOW_PRIVATE_NETWORK:'true'});
const settings=getConfig(),baseline=structuredClone(session),live={},events=[];
const checkpoint=path.join(directory,'checkpoint.json');
const save=()=>{fs.writeFileSync(checkpoint+'.tmp',JSON.stringify(session),{mode:0o600});fs.renameSync(checkpoint+'.tmp',checkpoint);};
const store={liveFor:()=>live,listLive:()=>[],publish(){},
	async commit(_s,type){events.push({type,at:Date.now(),section:founderDraftProgress(session).next});save();},
	async setStatus(s,status,detail){s.status=status;s.statusDetail=detail;save();},
	async addActivity(s,item){const a={id:randomUUID(),ts:Date.now(),...item};s.activities.push(a);save();return a;},
	async updateActivity(s,id,patch){Object.assign(s.activities.find(a=>a.id===id),patch);save();},
	async addMessage(s,item){const m={id:randomUUID(),ts:Date.now(),...item};s.messages.push(m);save();return m;}};
const initialInput=session.tokenUsage?.inputTokens||0,browserCount=session.activities.filter(a=>a.toolName?.startsWith('browser_')).length;
const result={status:'running',startedAt:new Date().toISOString(),source:'isolated copy of controlled live Founder checkpoint',provider:settings.provider,model:settings.model,sessionId:session.id,initialInputTokens:initialInput,savedSections:founderDraftProgress(session).completed,additionalInputEstimateCeiling:250000};
let record,abortReason;
const stop=reason=>{abortReason=reason;live.userStopRequested=true;live.controller?.abort();};
const timer=setTimeout(()=>stop('Report recovery exceeded ten minutes.'),600_000);timer.unref();
let prior;
const sampler=setInterval(()=>{
	const state=founderDraftProgress(session);
	const progress=JSON.stringify({status:session.status,sections:state.completed.length,next:state.next,additionalInputTokens:(session.tokenUsage?.inputTokens||0)-initialInput});
	if(progress!==prior){console.log(progress);prior=progress;}
	if(abortReason)stop(abortReason);
	if((session.tokenUsage?.inputTokens||0)-initialInput>250_000)stop('Report recovery exceeded its additional input estimate ceiling.');
},1000);sampler.unref();
try{
	await withUserConfiguration(settings,async()=>{throw new Error('Account preference changes are forbidden.');},async()=>{
		record=await ensureRuntime(session,store);
		await runTurn(session,{task:'Resume this saved Founder report after a process restart. Its browser investigation, public-only scope, context and observations are complete. Preserve saved sections and write only the next advertised typed section. When every section is saved, publish the exact complete draft_revision. Do not browse or repeat evidence collection.'},store);
	});
	assert.equal(abortReason,undefined,abortReason);assert.equal(session.status,'done',session.statusDetail);
	assert.ok(session.founder.finalizedAt&&session.founder.report);
	assert.deepEqual(founderDraftProgress(session).completed,FOUNDER_REPORT_SECTIONS);assert.equal(founderDraftProgress(session).intact,true);
	assert.deepEqual(session.founder.observations,baseline.founder.observations);
	for(const [section,value]of Object.entries(baseline.founder.reportDraft.input))assert.deepEqual(session.founder.reportDraft.input[section],value);
	assert.equal(session.activities.filter(a=>a.toolName?.startsWith('browser_')).length,browserCount,'Recovery replayed browser work.');
	assert.ok(session.tokenUsage.inputTokens>initialInput);assert.ok(session.todos.every(t=>t.status==='completed'));
	const reloaded=JSON.parse(fs.readFileSync(checkpoint));assert.deepEqual(reloaded.founder.report,session.founder.report);assert.deepEqual(reloaded.tokenUsage,session.tokenUsage);
	fs.writeFileSync(path.join(directory,'report.md'),buildFounderReportMarkdown(session));
	const pdf=await renderReportPdf(session);assert.equal(pdf.subarray(0,4).toString(),'%PDF');fs.writeFileSync(path.join(directory,'report.pdf'),pdf);
	assert.deepEqual(fs.readFileSync(source),sourceBytes,'The original checkpoint changed.');
	Object.assign(result,{status:'passed',sections:founderDraftProgress(session).completed,recommendations:session.founder.report.recommendations.length,additionalInputTokens:session.tokenUsage.inputTokens-initialInput,tokenUsage:session.tokenUsage,browserReplay:false,savedSectionsPreserved:true,checkpointRestoration:'passed',exports:'passed'});
}catch(error){result.status='failed';result.error=error.message;process.exitCode=1;save();}
finally{
	clearTimeout(timer);clearInterval(sampler);
	try{await record?.bridge?.service?.dispose?.();}finally{record?.dispose?.();deleteRunSnapshot(session.id);}
	result.finishedAt=new Date().toISOString();
	fs.writeFileSync(path.join(directory,'events.json'),JSON.stringify(events,null,2));
	const scan=folder=>{for(const entry of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isDirectory())scan(file);else{const bytes=fs.readFileSync(file);assert.ok(!secrets.some(secret=>bytes.includes(Buffer.from(secret))),`Configured credential appeared in artifact ${path.relative(directory,file)}`);}}};
	try{scan(directory);result.credentialScan='passed';}catch(error){result.status='failed';result.error=error.message;result.credentialScan='failed';process.exitCode=1;}
	fs.writeFileSync(path.join(directory,'result.json'),`${JSON.stringify(result,null,2)}\n`);console.log(JSON.stringify(result,null,2));
}
