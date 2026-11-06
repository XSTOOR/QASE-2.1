import test from 'node:test';
import assert from 'node:assert/strict';
import {createFounderDraftTool,founderDraftSchema,founderDraftProgress,resolveFounderDraft,FOUNDER_REPORT_SECTIONS,FOUNDER_DRAFT_PROTOCOL,initializeFounderReportGeneration,usesFounderDraft,founderDraftTools} from './founderReportDraft.js';
import {founderReportToolSchema} from './founderTools.js';
import {normalizeFounderReport} from './founderSchema.js';
import {prepareModeReportContinuation} from './agent.js';
import {buildFounderSynthesisContext} from './founderPrompt.js';

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

test('new canonical Founder drafts retain integrity across JSONB key reordering',async()=>{
 const {session,payload}=fixture();session.founder.execution={evidenceHashVersion:1};
 const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().reverse().map(key=>[key,reorder(value[key])])):value;
 const tool=createFounderDraftTool(session,{async commit(){}},founderReportToolSchema());
 await tool.run({section:'executive_summary',value:payload.executive_summary});await tool.run({section:'icp',value:payload.icp});
 const saved=reorder(session);assert.equal(founderDraftProgress(saved).intact,true);assert.equal(founderDraftProgress(saved).revision,session.founder.reportDraft.revision);
 saved.founder.reportDraft.input.icp.primary='Changed';assert.equal(founderDraftProgress(saved).intact,false);
});

test('each durable report revision can continue through the public SDK once without resetting usage or draft state',async()=>{
 const {session,payload}=fixture();session.activities=[];
 const state=session.founder.execution={discovery:{version:1},evidenceHashVersion:1,phase:'synthesis',actions:[],budgets:{reasonerTokens:1000000},telemetry:{reasoner:{inputTokens:40000}}};
 const tool=createFounderDraftTool(session,{async commit(){}},founderReportToolSchema());
 await tool.run({section:'executive_summary',value:payload.executive_summary});
 let cleared=0;const record={founderSynthesis:true,modeReasoning:{state},runtime:{clearConversation(){cleared++;}}};
 const usage=structuredClone(state.telemetry),revision=session.founder.reportDraft.revision;
 assert.equal(prepareModeReportContinuation(session,record),true);assert.equal(cleared,1);
 assert.equal(session.founder.reportDraft.revision,revision);assert.deepEqual(state.telemetry,usage);assert.equal(state.budgets.reasonerTokens,1000000);
 assert.equal(prepareModeReportContinuation(session,record),false);
 await tool.run({section:'icp',value:payload.icp});assert.equal(prepareModeReportContinuation(session,record),true);assert.equal(cleared,2);
 session.founder.reportDraft.input.icp.primary='Tampered';assert.equal(prepareModeReportContinuation(session,record),false);
});

test('qualified Founder section bounds reduce verbose payloads while retaining every original required report field',async()=>{
 const {session,payload}=fixture();session.founder.execution={evidenceHashVersion:1,discovery:{version:1}};
 const schema=founderReportToolSchema(),store={async commit(){}};
 const tool=createFounderDraftTool(session,store,schema);
 const rejected=await tool.run({section:'executive_summary',value:'Verbose '.repeat(200)});
 assert.equal(rejected.success,false);assert.equal(session.founder.reportDraft,undefined);
 for(const section of FOUNDER_REPORT_SECTIONS){
  const bounded=founderDraftSchema(session,schema).properties.value;
  if(schema.properties[section].type==='object')assert.deepEqual(bounded.required,schema.properties[section].required);
  for(const value of section==='recommendations'?payload.recommendations.map(item=>[item]):[payload[section]]){
   const result=await tool.run({section,value});assert.equal(result.success,true,result.error);
  }
 }
 const normalized=normalizeFounderReport(resolveFounderDraft(session,{draft_revision:session.founder.reportDraft.revision}),{observations:session.founder.observations,target:{name:'Fixture',url:'https://fixture.test/'},generatedAt:new Date().toISOString()});
 assert.equal(normalized.recommendations.length,3);assert.ok(normalized.plan.days30.length&&normalized.plan.days60.length&&normalized.plan.days90.length);
 assert.deepEqual(Object.keys(session.founder.reportDraft.input),FOUNDER_REPORT_SECTIONS);
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

test('configured-provider draft selection is durable and never migrates executed legacy, qualified or bounded JEV runs',()=>{
 const fresh=()=>({mode:'founder',activities:[],founder:{observations:[]}});
 const session=fresh();assert.equal(initializeFounderReportGeneration(session,'custom'),true);
 assert.equal(usesFounderDraft(JSON.parse(JSON.stringify(session))),true);
 assert.equal(initializeFounderReportGeneration(session,'custom'),false);
 for(const mutate of [s=>s.activities.push({toolName:'browser_open'}),s=>s.founder.observations.push({id:'observed'}),s=>s.founder.execution={strategy:'qualified-opus-jev-v1'},s=>s.founder.reportDraft={},s=>s.founder.finalizedAt='saved',s=>s.tokenUsage={totalTokens:20},s=>s.messages=[{role:'agent',text:'Prior model response'}],s=>s.mode='sqa']){
  const candidate=fresh();mutate(candidate);const before=structuredClone(candidate);
  assert.equal(initializeFounderReportGeneration(candidate,'custom'),false);assert.deepEqual(candidate,before);
 }
 assert.equal(initializeFounderReportGeneration(fresh(),'jev'),false);
 assert.throws(()=>initializeFounderReportGeneration(session,'jev'),/cannot resume/);
 assert.throws(()=>initializeFounderReportGeneration({mode:'founder',founder:{reportGeneration:{protocol:'unknown'}}},'custom'),/Unsupported saved/);
 assert.equal(usesFounderDraft({mode:'founder',founder:{execution:{reportProtocol:FOUNDER_DRAFT_PROTOCOL}}}),true);
});

test('configured-provider schemas advertise only the next bounded section, then the exact complete revision',async()=>{
 const {session,payload}=fixture();session.founder.reportGeneration={version:1,protocol:FOUNDER_DRAFT_PROTOCOL,evidenceHashVersion:1};
 const schema=founderReportToolSchema(),tools=[{name:'browser_snapshot',parametersSchema:{type:'object',properties:{}}},{name:'draft_founder_report_section'},{name:'finish_founder_review',parametersSchema:{type:'object',required:['draft_revision']}}];
 const tool=createFounderDraftTool(session,{async commit(){}},schema);
 assert.deepEqual(founderDraftTools(session,tools,schema).map(t=>t.name),['browser_snapshot']);
 assert.equal(founderDraftTools(session,tools,schema)[0],tools[0],'The original browser tool schema is forwarded intact.');
 for(const section of FOUNDER_REPORT_SECTIONS){
  const projected=founderDraftTools(session,tools,schema,{synthesis:true});
  assert.equal(projected.some(t=>t.name==='finish_founder_review'),false);
  const advertised=projected.find(t=>t.name==='draft_founder_report_section').parametersSchema;
  assert.deepEqual(advertised.properties.section.enum,[section]);
  if(section==='executive_summary')assert.equal(advertised.properties.value.maxLength,1200);
  for(const value of section==='recommendations'?payload.recommendations.map(item=>[item]):[payload[section]])assert.equal((await tool.run({section,value})).success,true);
 }
 const projected=founderDraftTools(session,tools,schema,{synthesis:true});
 assert.equal(projected.some(t=>t.name==='draft_founder_report_section'),false);
 assert.deepEqual(projected.find(t=>t.name==='finish_founder_review').parametersSchema.properties.draft_revision.enum,[session.founder.reportDraft.revision]);
 const untouched=tools.map(t=>({...t}));assert.deepEqual(founderDraftTools({mode:'sqa'},untouched,schema,{synthesis:true}),untouched);
});

test('configured-provider continuation and synthesis context restore saved sections without browser replay or usage reset',async()=>{
 const {session,payload}=fixture();session.activities=[];session.tokenUsage={inputTokens:42000,outputTokens:2000};
 session.founder.observations[0].summary='Observed practice entry in the controlled browser fixture.';
 session.founder.scope={target:{url:'https://fixture.test/'},access:{decision:'public_only'},contextDecision:{mode:'assumptions'}};
 session.founder.reportGeneration={version:1,protocol:FOUNDER_DRAFT_PROTOCOL,evidenceHashVersion:1};
 const tool=createFounderDraftTool(session,{async commit(){}},founderReportToolSchema());
 for(const section of ['executive_summary','icp','positioning','monetization'])await tool.run({section,value:payload[section]});
 await tool.run({section:'recommendations',value:[payload.recommendations[0]]});
 const restored=JSON.parse(JSON.stringify(session));let clears=0;
 const record={founderSynthesis:true,runtime:{clearConversation(){clears++;}}};
 assert.equal(prepareModeReportContinuation(restored,record),true);assert.equal(prepareModeReportContinuation(restored,record),false);
 assert.deepEqual(restored.tokenUsage,session.tokenUsage);assert.deepEqual(restored.founder.reportDraft,session.founder.reportDraft);
 const context=buildFounderSynthesisContext(restored);assert.match(context,/draft_founder_report_section/);assert.match(context,/public_only/);assert.match(context,/rec-0/);assert.match(context,/"next":"recommendations"/);
 restored.activities.push({status:'running'});assert.equal(prepareModeReportContinuation(restored,{...record,reportBoundaryRevision:undefined}),false);assert.equal(clears,1);
 const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reorder(value[key])])):value;
 assert.equal(founderDraftProgress(reorder(restored)).intact,true);
});

test('redelivery of the final recommendation is idempotent after advancing and rejects changed duplicate IDs',async()=>{
 const {session,payload}=fixture(),tool=createFounderDraftTool(session,{async commit(){}},founderReportToolSchema());
 for(const section of ['executive_summary','icp','positioning','monetization'])await tool.run({section,value:payload[section]});
 for(const recommendation of payload.recommendations)await tool.run({section:'recommendations',value:[recommendation]});
 const before=structuredClone(session.founder.reportDraft);
 assert.equal((await tool.run({section:'recommendations',value:[payload.recommendations[2]]})).cached,true);
 assert.equal((await tool.run({section:'recommendations',value:[{...payload.recommendations[2],title:'Changed'}]})).success,false);
 assert.deepEqual(session.founder.reportDraft,before);
});

test('concurrent section deliveries serialize persistence and a failed write cannot roll back a later section',async()=>{
 const {session,payload}=fixture();let release,entered;
 const began=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});let commits=0;
 const tool=createFounderDraftTool(session,{async commit(){commits++;if(commits===1){entered();await gate;throw new Error('Storage unavailable');}}},founderReportToolSchema());
 const first=tool.run({section:'executive_summary',value:payload.executive_summary});await began;
 const retry=tool.run({section:'executive_summary',value:payload.executive_summary});
 const next=tool.run({section:'icp',value:payload.icp});release();
 const results=await Promise.all([first,retry,next]);assert.deepEqual(results.map(r=>r.success),[false,true,true]);
 assert.equal(founderDraftProgress(session).next,'positioning');assert.equal(founderDraftProgress(session).intact,true);
});

test('typed report schemas constrain evidence and quick-win references to exact saved IDs',async()=>{
 const {session,payload}=fixture(),schema=founderReportToolSchema(),tool=createFounderDraftTool(session,{async commit(){}},schema);
 for(const section of FOUNDER_REPORT_SECTIONS){
  const advertised=founderDraftSchema(session,schema).properties.value;
  const check=(node,name)=>{
   if(name==='evidence_observation_ids')assert.deepEqual(node.items.enum,['observed']);
   if(name==='quick_wins')assert.deepEqual(node.items.enum,payload.recommendations.map(r=>r.id));
   if(node.type==='object')for(const [key,item]of Object.entries(node.properties))check(item,key);
   if(node.type==='array')check(node.items);
  };check(advertised,section);
  for(const value of section==='recommendations'?payload.recommendations.map(r=>[r]):[payload[section]])assert.equal((await tool.run({section,value})).success,true);
 }
});

test('unknown evidence returns exact repair choices without changing saved sections or accepting guessed references',async()=>{
 const {session,payload}=fixture(),schema=founderReportToolSchema(),tool=createFounderDraftTool(session,{async commit(){}},schema);
 await tool.run({section:'executive_summary',value:payload.executive_summary});const before=structuredClone(session.founder.reportDraft);
 const result=await tool.run({section:'icp',value:{...payload.icp,evidence_observation_ids:['mistyped-observation']}});
 assert.equal(result.success,false);assert.equal(result.code,'FOUNDER_DRAFT_UNKNOWN_EVIDENCE');
 assert.deepEqual(result.invalid_observation_ids,['mistyped-observation']);assert.deepEqual(result.allowed_observation_ids,['observed']);
 assert.deepEqual(session.founder.reportDraft,before);
 assert.equal((await tool.run({section:'icp',value:payload.icp})).success,true);assert.equal(founderDraftProgress(session).next,'positioning');
});
