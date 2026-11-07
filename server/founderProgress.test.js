import test from 'node:test';
import assert from 'node:assert/strict';
import { createFounderState,createFounderReviewTodos } from './founderService.js';
import { buildFounderProgress,founderRecoveryToken,founderContinuationTask } from './founderProgress.js';
import {createFounderDraftTool} from './founderReportDraft.js';
import {founderReportToolSchema} from './founderTools.js';

const fixture=()=>({id:'progress-fixture',mode:'founder',status:'interrupted',targetUrl:'https://fixture.test/',messages:[],secretNames:[],activities:[{id:'activity',toolName:'browser_open',status:'done',ts:Date.now()}],todos:createFounderReviewTodos(),founder:createFounderState({authorizationConfirmed:true,target:{name:'Fixture',url:'https://fixture.test/'}})});

test('progress follows saved evidence and sections, and ordinary investigation can resume without fabricated coverage',async()=>{
 const session=fixture();let progress=buildFounderProgress(session);
 assert.equal(progress.phase,'exploration');assert.equal(progress.lenses.completed,0);assert.equal(progress.recovery.available,true);assert.equal(progress.recovery.label,'Continue review');
 session.founder.reportGeneration={version:1,protocol:'section-draft-v1',evidenceHashVersion:1};
 const tool=createFounderDraftTool(session,{async commit(){}},founderReportToolSchema());await tool.run({section:'executive_summary',value:'Observed fixture. Outcomes remain unmeasured.'});
 progress=buildFounderProgress(session);assert.equal(progress.phase,'report');assert.equal(progress.report.completed,1);assert.equal(progress.report.total,11);
 assert.equal(progress.recovery.label,'Continue report');assert.match(founderContinuationTask(progress),/Do not repeat browser work/);
 assert.equal(progress.stages.find(s=>s.id==='publication').status,'pending');assert.equal(progress.finalized,false);
});

test('final publication is authoritative while complete todos or model prose are not a published report',()=>{
 const session=fixture();session.todos=session.todos.map(t=>({...t,status:'completed'}));session.messages.push({role:'agent',text:'The report is complete.'});
 assert.equal(buildFounderProgress(session).finalized,false);
 session.founder.finalizedAt='saved';session.founder.report={coverage:{categoriesReviewed:['product_clarity'],totalCategories:17}};
 const progress=buildFounderProgress(session);assert.equal(progress.finalized,true);assert.equal(progress.recovery.available,false);assert.ok(progress.stages.every(s=>s.status==='complete'));
});

test('pending decisions, active work, uncertain actions and missing usage each block continuation with an actionable reason',()=>{
 for(const [mutate,code]of [[s=>s.pendingQuestion={toolCallId:'question',credentialLike:true},'INPUT_REQUIRED'],[s=>s.activities.push({id:'active',status:'running'}),'ACTION_UNCERTAIN'],[s=>s.founder.execution={actions:[{status:'uncertain'}]},'ACTION_UNCERTAIN'],[s=>s.founder.execution={telemetry:{reasoner:{reservedTokens:200}}},'USAGE_UNVERIFIED'],[s=>s.founder.execution={modelBudget:{roles:{reasoner:{reservations:[{status:'uncertain'}]}}}},'USAGE_UNVERIFIED'],[s=>s.founder.execution={strategy:'unsupported'},'STRATEGY_UNSUPPORTED']]){
  const session=fixture();mutate(session);const progress=buildFounderProgress(session);
  assert.equal(progress.recovery.available,false);assert.match(progress.recovery.reason,/\S/);if(code==='INPUT_REQUIRED')assert.equal(progress.status,'waiting');else assert.equal(progress.pause.code,code);
 }
 for(const options of [{running:true},{resuming:true},{stopping:true}])assert.equal(buildFounderProgress(fixture(),options).recovery.available,false);
 assert.equal(buildFounderProgress(fixture(),{stopping:true}).title,'Stopping review');
});

test('tampered drafts, incompatible connections and approved budgets cannot be bypassed by a continue action',async()=>{
 const session=fixture();session.founder.reportGeneration={version:1,protocol:'section-draft-v1',evidenceHashVersion:1};
 const tool=createFounderDraftTool(session,{async commit(){}},founderReportToolSchema());await tool.run({section:'executive_summary',value:'Fixture evidence only.'});
 assert.equal(buildFounderProgress(session,{provider:'jev'}).pause.code,'CONNECTION_MISMATCH');
 session.founder.reportDraft.input.executive_summary='Changed';assert.equal(buildFounderProgress(session).pause.code,'DRAFT_CHANGED');
 const budget=fixture();budget.founder.execution={budgets:{durationMs:100},telemetry:{elapsedMs:100}};
 assert.equal(buildFounderProgress(budget).pause.code,'BUDGET_REACHED');assert.equal(buildFounderProgress(fixture(),{configReady:false}).pause.code,'CONNECTION_REQUIRED');
 const changed=fixture();changed.founder.investigationCheckpoint={version:1,entries:[],revision:'changed'};assert.equal(buildFounderProgress(changed).pause.code,'INVESTIGATION_CHANGED');
});

test('checkpoint tokens survive JSON key reordering but change with saved work, and reads never mutate the run',()=>{
 const session=fixture(),before=structuredClone(session),token=founderRecoveryToken(session);
 buildFounderProgress(session);assert.deepEqual(session,before);
 const reorder=v=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).reverse().map(k=>[k,reorder(v[k])])):v;
 assert.equal(founderRecoveryToken(JSON.parse(JSON.stringify(reorder(session)))),token);
 session.todos[0].status='completed';assert.notEqual(founderRecoveryToken(session),token);
 assert.equal(buildFounderProgress({mode:'sqa'}),undefined);
});
