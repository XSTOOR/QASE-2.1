import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {parse} from 'dotenv';
import {isolatedSqaEnvironment} from './sqa-test-runtime.mjs';
import {researchUrl} from '../server/sqaResearchTransport.js';
import {standaloneResearchProfile,standaloneProfileIdentity,validateStandaloneQualification} from '../server/sqaStandaloneQualification.js';
import {SQA_STANDALONE_STRATEGY} from '../server/sqaStandaloneStrategy.js';

// Inputs come from this invocation's three workers in a new private directory.
// Never accept a caller-supplied progress report, checkpoint or capability list.
export function trialCapabilities(first,final,restored,profile,env) {
 const state=final.sqa.execution, prior=first.sqa.execution, assessment=final.sqa.assessment;
 assert.equal(first.id,final.id); assert.equal(final.id,restored.id);
 assert.equal(state.strategy,SQA_STANDALONE_STRATEGY);
 assert.equal(state.profileIdentity,standaloneProfileIdentity(profile,env));
 assert.equal(prior.profileIdentity,state.profileIdentity);
 assert.equal(first.status,'interrupted'); assert.ok(!first.sqa.finalizedAt);
 assert.equal(final.status,'done'); assert.ok(final.sqa.finalizedAt);
 assert.equal(restored.status,'done');
 assert.deepEqual(restored.sqa,final.sqa);
 assert.deepEqual(final.sqa.publishedVersions.at(-1).assessment,assessment);
 const report=assessment.researchReport;
 assert.equal(report.runId,final.id);
 const finding=report.findings.find(f=>{
  try {const control=JSON.parse(f.observed);return control.selector==='#unlabelled' && control.name==='';}
  catch{return false;}
 });
 assert.ok(finding,'Missing the known accessible-name failure');
 const workflow=report.tests.find(test=>test.id===finding.testId && test.status==='failed');
 assert.ok(workflow?.observations.some(o=>o.evidenceId===finding.evidenceId && o.assertions.some(a=>a.outcome==='fail')));
 const completed=prior.workflows.find(w=>w.id===workflow.id && w.status==='failed' && w.evidenceIds.includes(finding.evidenceId));
 assert.ok(completed,'The finding must predate the worker restart');
 const retained=state.workflows.find(w=>w.id===completed.id);
 assert.deepEqual(retained.verification,completed.verification);
 assert.ok(state.recoveries.some(r=>state.evidence.some(e=>e.id===r.evidenceId)) && !state.recoveryRequired);
 assert.equal(state.telemetry.classifier.calls,0);
 assert.deepEqual(Object.keys(final.tokenUsage.byModel),[profile.reasoner.model]);
 assert.ok(state.telemetry.reasoner.usageReported && state.telemetry.reasoner.calls>prior.telemetry.reasoner.calls &&
  state.telemetry.reasoner.inputTokens>prior.telemetry.reasoner.inputTokens && state.telemetry.reasoner.outputTokens>0 &&
  state.telemetry.reasoner.reservedTokens===0);
 const searches=state.research.searches.filter(s=>s.runId===final.id && s.origin===new URL(env.QASE_SQA_SEARCH_URL).origin);
 const source=state.research.sources.find(src=>src.runId===final.id && src.authority==='verified_official' &&
  src.superseded===false && searches.some(s=>s.retrievedAt<=src.retrievedAt && s.urls.includes(src.url)) &&
  report.requirements.some(req=>req.sourceId===src.id && req.citationUse==='source excerpt' && workflow.requirementIds.includes(req.id)));
 assert.ok(source,'The workflow must cite an official technical source discovered by this search provider.');
 const requirement=report.requirements.find(req=>req.sourceId===source.id && workflow.requirementIds.includes(req.id));
 assert.ok(report.decisions.some(d=>d.id===workflow.decisionId && d.requirement_ids.includes(requirement.id)));
 assert.ok(report.documents.some(d=>d.requirementId===requirement.id && workflow.featureIds.includes(d.featureId) && d.documentHash));
 const refs={sdkLoop:'resume.json',singleModel:'resume.json',zeroJev:'resume.json',usage:'resume.json',browser:finding.evidenceId,
  research:requirement.id,checkpoint:'interrupt.json',continuation:'resume.json',cancellation:'interrupt.json',evidence:finding.evidenceId,
  publication:assessment.assessmentId,terminalStates:'export.json',search:searches.find(s=>s.urls.includes(source.url)).id,
  fetch:source.id,sourceAuthority:source.id,dynamicPlanning:workflow.id,complianceExecution:finding.evidenceId,exports:'report.pdf',restart:'export.json'};
 return Object.fromEntries(Object.entries(refs).map(([name,evidenceRef])=>[name,{passed:true,evidenceRef}]));
}

async function main() {
 const {values}=parseArgs({options:{'env-file':{type:'string'},check:{type:'boolean'}}});
 const settings=values['env-file']?parse(await readFile(values['env-file'])):{};
 const inputs={...settings,...process.env};
 const profile=standaloneResearchProfile({},inputs);
 if(!inputs.QASE_SQA_SEARCH_URL)throw Error('Missing QASE_SQA_SEARCH_URL. Supply the approved staging HTTPS search endpoint.');
 researchUrl(inputs.QASE_SQA_SEARCH_URL);
 if(!profile.reasoner.apiKey)throw Error('Missing standalone reasoning credential.');
 if(!inputs.QASE_SQA_REASONER_API_KEY && inputs.QASE_BASE_URL &&
    new URL(inputs.QASE_BASE_URL).origin!==new URL(profile.reasoner.endpoint).origin)
  throw Error('The configured gateway key belongs to another endpoint. Supply the standalone reasoning credential.');
 if(values.check){console.log('Search URL and reasoning credential configured. Connectivity and execution still require the live trial.');return;}
 assert.equal(process.env.QASE_LIVE_SYSTEM_QUALIFICATION,'true','Set QASE_LIVE_SYSTEM_QUALIFICATION=true to run the live trial.');
 assert.notEqual(process.env.NODE_ENV,'production');
 const id=randomUUID(), directory=path.resolve('.qase/validation/standalone',id);
 await mkdir(directory,{recursive:true,mode:0o700});
 const env={...isolatedSqaEnvironment(),NODE_ENV:'development',QASE_LIVE_SYSTEM_QUALIFICATION:'true',
  QASE_API_KEY:profile.reasoner.apiKey,QASE_SQA_REASONER_API_KEY:profile.reasoner.apiKey,QASE_SQA_SEARCH_URL:inputs.QASE_SQA_SEARCH_URL,
  QASE_PROVIDER:'custom',QASE_MODEL:profile.reasoner.model,QASE_BASE_URL:new URL(profile.reasoner.endpoint).origin+'/v1',
  QASE_SQA_STANDALONE_ENABLED:'true',QASE_ALLOW_PRIVATE_NETWORK:'true',QASE_BROWSER_ALLOWED_PRIVATE_HOSTS:'127.0.0.1'};
 let rejectedWrites=0;
 const server=createServer((req,res)=>{
  if(req.method!=='GET'){rejectedWrites++;res.writeHead(405).end();return;}
  res.writeHead(200,{'Content-Type':'text/html'}).end('<!doctype html><html lang="en"><title>Practice registration</title><main><h1>Register for a demo</h1><form onsubmit="return false"><label for="nickname">Display name</label><input required id="nickname"><button id="unlabelled" type="button"></button></form></main></html>');
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const target='http://127.0.0.1:'+server.address().port+'/';
 const deadline=Date.now()+15*60_000;
 console.log('Qualification evidence directory: '+directory);
 try {
  for(const phase of ['interrupt','resume','export']){
   const child=fork(fileURLToPath(new URL('./standalone-trial-worker.mjs',import.meta.url)),[phase,id,target],
    {cwd:directory,env,execArgv:[],stdio:['ignore','inherit','inherit','ipc'],windowsHide:true});
   const timeout=setTimeout(()=>child.kill('SIGKILL'),Math.max(1,deadline-Date.now()));
   try {const [code]=await once(child,'exit');assert.equal(code,0,phase+' worker failed or timed out');}
   finally{clearTimeout(timeout);}
  }
  assert.equal(rejectedWrites,0);
  const snapshots=await Promise.all(['interrupt','resume','export'].map(async phase=>JSON.parse(await readFile(path.join(directory,phase+'.json'),'utf8'))));
  assert.ok(snapshots.every(s=>s.id===id && s.targetUrl===target));
  const capabilities=trialCapabilities(...snapshots,profile,env);
  const receipt={strategy:SQA_STANDALONE_STRATEGY,sdkVersion:profile.sdkVersion,profileIdentity:standaloneProfileIdentity(profile,env),
   checkedAt:Date.now(),runId:id,jevCalls:0,capabilities,evidenceDirectory:directory};
  validateStandaloneQualification(profile,receipt,Date.now(),env);
  const destination=path.resolve(inputs.QASE_SQA_QUALIFICATION_FILE || '.qase/qualifications/sqa-standalone.json');
  await mkdir(path.dirname(destination),{recursive:true,mode:0o700});
  const temporary=destination+'.'+id+'.tmp';
  await writeFile(temporary,JSON.stringify(receipt,null,2),{mode:0o600,flag:'wx'});
  await rename(temporary,destination);
  console.log('Standalone qualification passed. Receipt: '+destination);
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
