import test from 'node:test';
import assert from 'node:assert/strict';
import {createFounderDraftTool,founderDraftSchema,founderDraftProgress,resolveFounderDraft,FOUNDER_REPORT_SECTIONS} from './founderReportDraft.js';
import {founderReportToolSchema} from './founderTools.js';
import {normalizeFounderReport} from './founderSchema.js';

function fixture(){
 const session={id:'draft-fixture',mode:'founder',status:'running',founder:{observations:[{id:'observed',category:'product_clarity'}]}};
 const proof={evidence_observation_ids:['observed'],assumptions:[]};
 const payload={executive_summary:'The observed local product offers task practice. Business outcomes remain unmeasured.',
  icp:{primary:'Small teams, as a hypothesis',users:['Team members'],buyers:['Team leads'],jobs:['Practice tasks'],pains:['Unclear task requirements'],...proof},
  positioning:{category:'Task practice',one_liner:'Practice a task locally.',value_proposition:'Clarify the next action.',differentiators:['Local task practice'],alternatives:['Manual notes'],...proof},
  monetization:{model:'Subscription hypothesis',value_metric:'Active practicing teams',packages:['Team pilot'],pricing_presentation:'Describe the pilot scope.',next_tests:['Interview a team lead.'],...proof},
  recommendations:['product_clarity','onboarding','activation'].map((category,i)=>({id:`rec-${i}`,category,title:`Improve ${category}`,opportunity:'The observed task entry needs clearer guidance.',proposed_feature:'Add a sample task.',why_it_matters:'Teams need a starting point.',intended_outcome:'Clearer first task entry.',priority_reason:'Addresses an observed first-use step.',actions:['Test a sample task.'],implementation_scope:'Update the task hint.',acceptance_criteria:['The hint is visible.','The hint describes the task constraints.'],dependencies:[],impact:'medium',effort:'small',confidence:'medium',...proof})),
  marketing:{channels:[{channel:'Team task demo',rationale:'Demonstrate the observed practice flow.',first_test:'Show the demo to a team.',confidence:'medium',...proof}],content_angles:['Task practice'],launch_motions:['Pilot invitation'],growth_loops:['Share a practice template'],assumptions:['Acquisition is unmeasured.']},
  sales:{motion:'Scoped pilot hypothesis',qualification_questions:['Which tasks are hard to repeat?'],objection_responses:[{objection:'We use notes.',response:'Compare a practice example with notes.'}],sales_assets:['Annotated task example'],...proof},
  risks:[{title:'Unknown demand',likelihood:'medium',impact:'high',mitigation:'Interview target teams.',evidence_observation_ids:[],assumptions:['No demand data was supplied.']}],
  quick_wins:['rec-0'],plan:{days_30:['Interview users.'],days_60:['Test task guidance.'],days_90:['Review pilot evidence.']},
  metrics:{north_star:{name:'Useful practice completions',definition:'Completed local practice with a useful next step.',why:'Connects the task to its intended use.',...proof},candidates:[{name:'Task abandonment',definition:'Started practice without completion.',...proof}],experiments:[{hypothesis:'A sample task may clarify entry.',change:'Add a sample task.',success_metric:'Practice completion',timebox:'Two weeks',guardrail:'No loss of editable input',...proof}]}};
 return {session,payload};
}

test('eleven typed sections survive checkpoint restoration and the original complete report validator',async()=>{
 const {session,payload}=fixture(),commits=[],schema=founderReportToolSchema();
 let current=session;
 for(const section of FOUNDER_REPORT_SECTIONS){
  const tool=createFounderDraftTool(current,{async commit(){commits.push(section);}},schema);
  assert.deepEqual(founderDraftSchema(current,schema).properties.section.enum,[section]);
  for(const value of section==='recommendations'?payload.recommendations.map(item=>[item]):[payload[section]]){
   const result=await tool.run({section,value});assert.equal(result.success,true,result.error);
  }
  current=JSON.parse(JSON.stringify(current));
 }
 const progress=founderDraftProgress(current);assert.equal(progress.next,null);assert.equal(progress.intact,true);assert.equal(commits.length,13);
 const restored=resolveFounderDraft(current,{draft_revision:progress.revision});assert.deepEqual(restored,payload);
 assert.throws(()=>resolveFounderDraft(current,{draft_revision:'wrong'}),/exact revision/);
 const report=normalizeFounderReport(restored,{observations:current.founder.observations,target:{name:'Fixture',url:'https://fixture.test/'},generatedAt:new Date().toISOString()});
 assert.equal(report.recommendations.length,3);assert.equal(report.plan.days90.length,1);
});

test('malformed section types, unknown evidence and unsupported promises fail without publishing or overwriting a draft',async()=>{
 const {session,payload}=fixture(),schema=founderReportToolSchema(),tool=createFounderDraftTool(session,{async commit(){}},schema);
 assert.equal((await tool.run({section:'icp',value:'<parameter>not JSON object</parameter>'})).success,false);
 assert.equal(session.founder.reportDraft,undefined);
 await tool.run({section:'executive_summary',value:payload.executive_summary});
 const unknown={...payload.icp,evidence_observation_ids:['not-observed']};
 assert.match((await tool.run({section:'icp',value:unknown})).error,/unknown observation/);
 assert.equal(founderDraftProgress(session).next,'icp');
 for(const section of ['icp','positioning','monetization'])assert.equal((await tool.run({section,value:payload[section]})).success,true);
 const promised=structuredClone(payload.recommendations);promised[0].intended_outcome='Increase conversions by 50%';
 assert.equal((await tool.run({section:'recommendations',value:[promised[0]]})).success,false);
 assert.equal(session.founder.finalizedAt,undefined);
});

test('idempotent delivery, revision-checked correction, cancellation and persistence failure retain draft integrity',async()=>{
 const {session,payload}=fixture(),schema=founderReportToolSchema();let commits=0,fail=false,cancel=false;
 const tool=createFounderDraftTool(session,{async commit(){if(fail)throw new Error('Storage unavailable');commits++;}},schema,{isCancelled:()=>cancel});
 const first=await tool.run({section:'executive_summary',value:payload.executive_summary});assert.equal(commits,1);
 assert.equal((await tool.run({section:'executive_summary',value:payload.executive_summary})).cached,true);assert.equal(commits,1);
 assert.equal((await tool.run({section:'executive_summary',value:'Changed draft'})).success,false);
 assert.equal((await tool.run({section:'executive_summary',value:'Changed draft',replace_revision:first.revision})).success,true);
 const before=structuredClone(session.founder.reportDraft);fail=true;
 assert.equal((await tool.run({section:'icp',value:payload.icp})).success,false);assert.deepEqual(session.founder.reportDraft,before);
 cancel=true;assert.equal((await tool.run({section:'icp',value:payload.icp})).success,false);assert.deepEqual(session.founder.reportDraft,before);
 cancel=false;fail=false;session.founder.observations.push({id:'new-observation'});
 assert.match((await tool.run({section:'icp',value:payload.icp})).error,/evidence or content changed/);
});

test('unfinished exploration cannot draft a report, and tampered sections cannot reach publication',async()=>{
 const {session,payload}=fixture(),schema=founderReportToolSchema();let ready=false;
 const tool=createFounderDraftTool(session,{async commit(){}},schema,{canDraft:()=>ready});
 assert.match((await tool.run({section:'executive_summary',value:payload.executive_summary})).error,/prerequisites/);
 ready=true;await tool.run({section:'executive_summary',value:payload.executive_summary});
 session.founder.reportDraft.input.executive_summary='Tampered';
 assert.equal(founderDraftProgress(session).intact,false);assert.throws(()=>resolveFounderDraft(session,{}),/intact/);
});
