/** Independent audit of the disposable four-page live-model qualification.
 * Reads saved host receipts, never model completion prose. No model requests,
 * browser replay, production access or changes to the original run artifacts. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolveFounderDraft} from '../server/founderReportDraft.js';
import {normalizeFounderReport,FOUNDER_CATEGORY_IDS} from '../server/founderSchema.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
export function verifySystemModeEvidence(directory){
 const checkpoint=fs.readFileSync(path.join(directory,'checkpoint.json'));
 const resultFile=fs.readFileSync(path.join(directory,'result.json'));
 const session=JSON.parse(checkpoint),result=JSON.parse(resultFile),mode=session.mode;
 assert.ok(['sqa','founder'].includes(mode));
 assert.equal(result.runId,session.id);assert.equal(session.status,'done');
 assert.equal(result.timedOut,false);assert.equal(result.writes,0);assert.equal(result.reportPublished,true);
 assert.ok(session[mode].finalizedAt);assert.ok(session.todos.length>0);
 assert.ok(session.todos.every(todo=>todo.status==='completed'),'Publication and technical plan tasks must all be complete.');
 const execution=session[mode].execution;
 assert.ok(['/','/docs','/pricing','/practice'].every(p=>execution.routes.some(r=>r.reviewed&&new URL(r.url).pathname===p)));
 const receipts=execution.evidence;
 for(const receipt of receipts)assert.equal(hash(JSON.stringify(receipt.result)),receipt.digest,'A saved receipt must retain its original digest.');
 const practice=receipts.filter(r=>r.tool==='browser_snapshot'&&r.result.url&&new URL(r.result.url).pathname==='/practice').sort((a,b)=>a.at-b.at);
 const passed=practice.find(r=>r.result.bodyText.includes('Local task saved'));
 assert.ok(passed,'The actual Practice output must be observed after submission.');
 const unsuccessful=practice.filter(r=>r.at<passed.at&&!r.result.bodyText.includes('Local task saved'));
 assert.ok(unsuccessful.length>=3,'Initial, empty and one-character states require separate observations.');
 const activities=session.activities.filter(a=>a.status==='done');
 const negative=activities.find(a=>a.toolName==='browser_fill'&&/ = A$/.test(a.detail||''));
 const positive=activities.find(a=>a.toolName==='browser_fill'&&/ = Alpha$/.test(a.detail||''));
 assert.ok(negative&&positive&&negative.ts<positive.ts);
 assert.ok(unsuccessful.some(r=>r.at>negative.ts&&r.at<positive.ts));
 assert.ok(activities.some(a=>a.toolName==='browser_click'&&a.ts>positive.ts&&a.ts<passed.at));
 for(const receipt of practice)assert.ok(activities.some(a=>a.id===receipt.activityId&&a.toolName==='browser_snapshot'));
 const roles=execution.modelBudget.roles;
 assert.ok(Object.values(roles).every(role=>role.reservations.every(r=>r.status==='settled')),'No unresolved model usage can be hidden.');
 assert.equal(session.tokenUsage.estimated,false);
 assert.equal(session.tokenUsage.totalTokens,['reasoner','classifier'].reduce((sum,role)=>sum+execution.telemetry[role].inputTokens+execution.telemetry[role].outputTokens,0));
 assert.ok(execution.telemetry.classifier.calls>0);
 if(mode==='founder'){
  assert.ok(FOUNDER_CATEGORY_IDS.every(category=>session.founder.observations.some(o=>o.category===category&&o.evidence?.length)));
  const report=normalizeFounderReport(resolveFounderDraft(session,{draft_revision:session.founder.reportDraft.revision}),{observations:session.founder.observations,target:session.founder.scope.target,generatedAt:session.founder.report.generatedAt});
  assert.deepEqual(report,session.founder.report,'Saved draft must reproduce the complete original report schema.');
 }else{
  assert.ok(session.sqa.scope.applicableControlIds.every(id=>session.sqa.observations.some(o=>o.controlId===id&&['pass','fail','blocked','not_assessed'].includes(o.status))));
  assert.equal(session.sqa.assessment.verdict,'blocked','Unavailable reviewer artifacts must not become a pass.');
 }
 return {passed:true,mode,runId:session.id,pagesReviewed:4,accountedPlanItems:session.todos.length,observations:session[mode].observations.length,
  negativeFillActivity:negative.id,positiveFillActivity:positive.id,practiceReceiptIds:practice.map(r=>r.id),positiveReceiptId:passed.id,
  exactUsage:session.tokenUsage.totalTokens,reportPersisted:true,checkpointSha256:hash(checkpoint),resultSha256:hash(resultFile),
  scope:'Four-page disposable fixture only; no production or distributed browser recovery qualification.'};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const directory=path.resolve(process.argv[2]);const result=verifySystemModeEvidence(directory);
 fs.writeFileSync(path.join(directory,'evidence-audit.json'),JSON.stringify(result,null,2),{mode:0o600});
 console.log(JSON.stringify(result,null,2));
}
