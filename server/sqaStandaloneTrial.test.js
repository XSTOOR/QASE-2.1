import test from 'node:test';
import assert from 'node:assert/strict';
import {runStandaloneTrial,requireStandaloneExecution,standaloneResearchProfile,
 standaloneProfileIdentity,SQA_STANDALONE_CAPABILITIES} from './sqaStandaloneQualification.js';
import {SQA_STANDALONE_STRATEGY} from './sqaStandaloneStrategy.js';
import {trialCapabilities} from '../scripts/qualify-sqa-standalone.mjs';

test('trial admission is isolated to one in-process development run and profile',async t=>{
 const settings={NODE_ENV:'development',QASE_LIVE_SYSTEM_QUALIFICATION:'true',
  QASE_SQA_SEARCH_URL:'https://search.example.test/search',QASE_SQA_QUALIFICATION_FILE:'absent-fixture-receipt',
  QASE_SQA_REASONER_API_KEY:'fixture'};
 for(const [key,value] of Object.entries(settings)){
  const previous=process.env[key];process.env[key]=value;
  t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});
 }
 const profile=standaloneResearchProfile({});
 const session={mode:'sqa',ownerUserId:'standalone-qualification',targetUrl:'http://127.0.0.1:4567/',
  sqa:{scope:{authorization:{confirmed:true}}}};
 assert.throws(()=>requireStandaloneExecution(session,profile),/unqualified/);
 await runStandaloneTrial(session,profile,async()=>{
  await Promise.resolve(); requireStandaloneExecution(session,profile);
  assert.throws(()=>requireStandaloneExecution(structuredClone(session),profile),/unqualified/);
  assert.throws(()=>requireStandaloneExecution(session,profile,{...process.env,QASE_SQA_SEARCH_URL:'https://other.example.test/search'}),/unqualified/);
 });
 assert.throws(()=>requireStandaloneExecution(session,profile),/unqualified/);
 assert.throws(()=>runStandaloneTrial({...session,targetUrl:'https://public.example.test/'},profile,()=>{}),/isolated/);
 process.env.NODE_ENV='production';
 assert.throws(()=>runStandaloneTrial(session,profile,()=>{}),/isolated/);
});

test('qualification evidence must connect search, browser failure, checkpoint, document and publication',()=>{
 const env={QASE_SQA_REASONER_API_KEY:'fixture',QASE_SQA_SEARCH_URL:'https://search.example.test/search'};
 const profile=standaloneResearchProfile({},env), url='https://www.w3.org/TR/example/';
 const testWorkflow={id:'workflow',status:'failed',verification:{digest:'abc'},evidenceIds:['browser']};
 const report={runId:'run',findings:[{testId:'workflow',evidenceId:'browser',observed:'{"selector":"#unlabelled","name":""}'}],
  tests:[{id:'workflow',status:'failed',requirementIds:['req'],decisionId:'dec',featureIds:['feature'],observations:[{evidenceId:'browser',assertions:[{outcome:'fail'}]}]}],
  requirements:[{id:'req',sourceId:'src',citationUse:'source excerpt'}],decisions:[{id:'dec',requirement_ids:['req']}],
  documents:[{requirementId:'req',featureId:'feature',documentHash:'hash'}]};
 const assessment={assessmentId:'assessment',researchReport:report};
 const execution={strategy:SQA_STANDALONE_STRATEGY,profileIdentity:standaloneProfileIdentity(profile,env),
  telemetry:{reasoner:{calls:4,inputTokens:40,outputTokens:2,reservedTokens:0,usageReported:true},classifier:{calls:0}},
  recoveries:[{evidenceId:'recovery'}],evidence:[{id:'recovery'}],workflows:[testWorkflow],
  research:{sources:[{id:'src',url,authority:'verified_official',superseded:false,runId:'run',retrievedAt:2}],
   searches:[{id:'search',urls:[url],origin:'https://search.example.test',runId:'run',retrievedAt:1}]}};
 const final={id:'run',status:'done',tokenUsage:{byModel:{[profile.reasoner.model]:{}}},sqa:{execution,finalizedAt:3,assessment,publishedVersions:[{assessment}]}};
 const first=structuredClone(final);first.status='interrupted';delete first.sqa.finalizedAt;
 first.sqa.execution.telemetry.reasoner.calls=2;first.sqa.execution.telemetry.reasoner.inputTokens=20;
 const verify=(last)=>trialCapabilities(first,last,structuredClone(last),profile,env);
 assert.deepEqual(Object.keys(verify(final)).sort(),[...SQA_STANDALONE_CAPABILITIES].sort());
 for(const invalidate of [
  s=>{s.sqa.execution.research.searches[0].urls=[];},s=>{s.sqa.execution.telemetry.classifier.calls++;},
  s=>{s.sqa.execution.recoveries=[];},s=>{s.sqa.assessment.researchReport.documents=[];},
  s=>{s.sqa.execution.workflows[0].verification.digest='changed';},s=>{s.sqa.finalizedAt=null;}
 ]){const bad=structuredClone(final);invalidate(bad);assert.throws(()=>verify(bad));}
});
