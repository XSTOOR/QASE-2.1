import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createModeReasoningRuntime, selectsModeReasoning } from './modeReasoningRuntime.js';
import { hybridProfile } from './hybridConfig.js';
import { SQA_STANDALONE_STRATEGY } from './sqaStandaloneStrategy.js';
import { modeWorkReadiness } from './modeDiscovery.js';
import { buildModeExecutionContext } from './modeReasoningContext.js';

test('standalone SQA exposes no classifier, refuses stale classifier calls before dispatch, and retains SDK accounting', async()=>{
 const session={id:randomUUID(),mode:'sqa',sqa:{observations:[],scope:{}},activities:[],todos:[]};
 let networkCalls=0,toolCalls=0,commits=0;
 const profile={...hybridProfile({apiKey:'fixture'}),executionStrategy:SQA_STANDALONE_STRATEGY};
 const runtime=createModeReasoningRuntime({session,profile,record:{},runStore:{async commit(){commits++;}},fetchImpl:async()=>{networkCalls++;throw new Error('Unexpected network');}});
 assert.equal(session.sqa.execution.strategy,SQA_STANDALONE_STRATEGY);
 assert.equal(runtime.tools.some(t=>t.name==='classify_mode_observations'),false);
 await assert.rejects(runtime.router.classifier([],{}),/classifier dispatch is forbidden/);
 await assert.rejects(runtime.wrapTool({name:'classify_mode_observations',run(){toolCalls++;}}).run({}),/does not expose/);
 assert.equal(networkCalls,0);assert.equal(toolCalls,0);
 const service={async chat(_messages,options){runtime.usage({reservationId:options.qaseBudgetReservationId,callId:randomUUID(),inputTokens:10,outputTokens:2,estimated:false});return (async function*(){yield {type:'text',content:'Observed evidence needs further testing.'};})();}};
 runtime.wrapChat(service);
 for await(const part of await service.chat([]))assert.equal(part.type,'text');
 assert.equal(runtime.state.telemetry.reasoner.calls,1);
 assert.equal(runtime.state.telemetry.classifier.calls,0);
 assert.ok(commits>0);assert.equal(session.sqa.finalizedAt,undefined);
 assert.match(buildModeExecutionContext(session),/One reasoning model/);
 assert.doesNotMatch(buildModeExecutionContext(session),/Classify one intact receipt with JEV/);
});

test('historical SQA stays on its saved adapter and standalone intent cannot fall back',()=>{
 const s={mode:'sqa',sqa:{},activities:[]};
 assert.equal(selectsModeReasoning(s,{}),false);
 assert.equal(selectsModeReasoning(s,{QASE_SQA_STANDALONE_ENABLED:'true'}),false);
 s.sqa.requestedExecutionStrategy=SQA_STANDALONE_STRATEGY;
 assert.equal(selectsModeReasoning(s,{}),true);
 s.sqa.execution={strategy:SQA_STANDALONE_STRATEGY};
 assert.equal(selectsModeReasoning(s,{}),true);
 assert.throws(()=>selectsModeReasoning({mode:'founder',founder:{execution:s.sqa.execution}},{}),/Unsupported/);
});

test('removing classifier requirement does not certify missing discovery or workflows',()=>{
 const session={id:randomUUID(),mode:'sqa',targetUrl:'https://fixture.test',activities:[],sqa:{observations:[]}};
 createModeReasoningRuntime({session,profile:{...hybridProfile({apiKey:'fixture'}),executionStrategy:SQA_STANDALONE_STRATEGY},record:{},runStore:{async commit(){}}});
 const status=modeWorkReadiness(session);
 assert.equal(status.classificationRequired,false);
 assert.equal(status.ready,false);
});

test('new research advances standalone checkpoints and rejected citations do not mark browser actions uncertain',async()=>{
 const {ResearchInputError}=await import('./sqaResearch.js');
 const session={id:randomUUID(),mode:'sqa',sqa:{observations:[],scope:{}},activities:[],todos:[]};
 const runtime=createModeReasoningRuntime({session,profile:{...hybridProfile({apiKey:'fixture'}),executionStrategy:SQA_STANDALONE_STRATEGY},record:{},runStore:{async commit(){}}});
 const before=runtime.progress();
 runtime.state.research.requirements.push({id:'req-1'});
 assert.notEqual(runtime.progress(),before);
 const after=runtime.progress();
 runtime.state.research.calls++;
 assert.equal(runtime.progress(),after);
 const result=await runtime.wrapTool({name:'sqa_record_requirement',async run(){throw new ResearchInputError('Quotation is absent');}}).run({});
 assert.equal(result.code,'SQA_RESEARCH_INPUT');
 assert.equal(runtime.state.actions.at(-1).status,'failed');
});
