// Private subprocess of qualify-sqa-standalone.mjs. Each phase opens the same
// isolated local store in a fresh process and gets a fresh browser runtime.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {createLocalApplicationServices} from '../server/localServices.js';
import {getConfig} from '../server/config.js';
import {runTurn, ensureRuntime} from '../server/agent.js';
import {createSqaState, createSqaTodoPlan} from '../server/sqaService.js';
import {recordSqaDocumentReview} from '../server/sqaDocumentReview.js';
import {renderReportPdf} from '../server/reportPdf.js';
import {buildSqaReportMarkdown} from '../server/sqaAssessment.js';
import {SQA_STANDALONE_STRATEGY} from '../server/sqaStandaloneStrategy.js';
import {runStandaloneTrial, standaloneResearchProfile} from '../server/sqaStandaloneQualification.js';

const [phase,id,targetUrl] = process.argv.slice(2);
assert.ok(process.send && ['interrupt','resume','export'].includes(phase));
assert.equal(process.env.NODE_ENV,'development');
const ownerUserId = 'standalone-qualification';
const services = createLocalApplicationServices({tenantContext:{actorUserId:ownerUserId}});
const store = services.runs;
await store.load();
let session, unsubscribe, runtime;
try {
 if (phase === 'interrupt') {
  session = await store.create('Standalone qualification',{id,ownerUserId,engine:'chromium'});
  session.mode='sqa';
  session.targetUrl=targetUrl;
  session.sqa=createSqaState({authorizationConfirmed:true,profiles:['core'],assessmentType:'browser',
   scopeNotes:'Authorized public-only practice registration. No account or external form submission is in scope.',
   target:{name:'Practice registration',url:targetUrl,release:'qualification',environment:'isolated'}});
  session.sqa.requestedExecutionStrategy=SQA_STANDALONE_STRATEGY;
  session.todos=createSqaTodoPlan(session.sqa);
  await store.commit(session,'sqa.created');
 } else session=await store.get(id);
 assert.equal(session?.ownerUserId,ownerUserId);
 assert.equal(session.targetUrl,targetUrl);
 if (phase === 'export') {
  assert.equal(session.status,'done');
  assert.ok(session.sqa.finalizedAt && session.sqa.assessment.researchReport);
  const markdown=buildSqaReportMarkdown(session.sqa.assessment);
  assert.ok(markdown.includes('#unlabelled'));
  const pdf=await renderReportPdf(session);
  assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
  await writeFile('report.md',markdown);
  await writeFile('report.pdf',pdf);
 } else {
  if (phase === 'resume') {
   assert.equal(session.status,'interrupted');
   const state=session.sqa.execution;
   const failed=state.workflows.find(w=>w.status==='failed' && w.evidenceIds.length);
   const decision=state.research.applicability.find(d=>d.id===failed?.researchLink?.decisionId);
   assert.ok(decision,'Missing scope for the qualification reviewer document');
   const excerpt='The sample agreement covers the registration form in this staging qualification.';
   await recordSqaDocumentReview(session,{requirementId:decision.requirement_ids[0],featureId:failed.feature_ids[0],
    determination:'CONFIRMED_APPLICABLE',obligation:'contractual',jurisdiction:'qualification fixture',
    documentText:excerpt,excerpt},{role:'owner',actorUserId:ownerUserId},store);
  }
  let stopped=false;
  await runStandaloneTrial(session,standaloneResearchProfile(getConfig()),async()=>{
   runtime=await ensureRuntime(session,store);
   if (phase==='interrupt') unsubscribe=store.subscribe(id,()=>{
    const state=session.sqa.execution;
    if (!stopped && state?.workflows.some(w=>w.status==='failed' && w.evidenceIds.length) &&
        !state.telemetry.reasoner.reservedTokens && state.actions.every(a=>!['running','prepared','uncertain'].includes(a.status)) &&
        runtime.controller && runtime.running) {
     stopped=true;
     services.agent.stop(id);
    }
   });
   const task=(phase==='resume'?'Continue the interrupted assessment. First verify recovery in the new browser. Preserve all completed checks. ':'')+
    'Review only the authorized local registration form at '+targetUrl+'. Discover the page. Use web_search on the approved provider to find the official W3C Accessible Name and Description Computation specification. Fetch a returned official publication and cite its technical body. Treat it as a voluntary recommendation. Plan and run a research-linked accessibility check for unnamed controls. Record the available browser evidence and explicitly disposition missing evidence. Complete the canonical assessment and publish through the normal report tool. No credentials or external submissions are needed.';
   await store.addMessage(session,{role:'user',text:task});
   await runTurn(session,{task},store);
  });
  assert.equal(session.status,phase==='interrupt'?'interrupted':'done',session.statusDetail);
  if (phase==='interrupt') assert.ok(stopped && !session.sqa.finalizedAt,'Expected a controlled stop before publication');
 }
 await writeFile(phase+'.json',JSON.stringify(session),{mode:0o600});
} finally {
 unsubscribe?.();
 try {await runtime?.bridge?.service?.dispose?.();} finally {runtime?.dispose?.();await services.lifecycle.close();}
}
