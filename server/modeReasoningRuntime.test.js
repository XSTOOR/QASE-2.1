import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { selectsModeReasoning, createModeReasoningRuntime, modeExplorationReadiness, MODE_REASONING_STRATEGY } from './modeReasoningRuntime.js';
import { hybridProfile } from './hybridConfig.js';

function fixture(mode='sqa', store={async commit(){}}) {
 const session={id:randomUUID(),mode,[mode]:{observations:[]},activities:[],todos:[]};
 const record={};const runtime=createModeReasoningRuntime({session,runStore:store,profile:hybridProfile({apiKey:'fixture'}),record});
 return {session,runtime,record,state:session[mode].execution};
}
for(const mode of ['sqa','founder']) test(`${mode} reasoning is opt-in and saved selection survives flag rollback`,()=>{
 const session={mode,[mode]:{observations:[]},activities:[]};
 assert.equal(selectsModeReasoning(session,{}),false);
 assert.equal(selectsModeReasoning(session,{[`QASE_${mode.toUpperCase()}_REASONING_ENABLED`]:'true'}),true);
 session.activities.push({status:'done'});assert.equal(selectsModeReasoning(session,{[`QASE_${mode.toUpperCase()}_REASONING_ENABLED`]:'true'}),false);
 session[mode].execution={strategy:MODE_REASONING_STRATEGY};assert.equal(selectsModeReasoning(session,{}),true);
 session[mode].execution.strategy='unknown';assert.throws(()=>selectsModeReasoning(session,{}));
});

for(const mode of ['sqa','founder']) test(`${mode} durable publication stops SDK model prefetch, never model prose`,async()=>{
 const f=fixture(mode);let requests=0,published=0;
 f.record.onModePublished=()=>published++;
 const service={async chat(){requests++;throw new Error('No model dispatch after durable publication');}};
 f.runtime.wrapChat(service);
 const name=mode==='sqa'?'finish_sqa_assessment':'finish_founder_review';
 const rejected=f.runtime.wrapTool({name,async run(){return {success:false,published:false};}});
 await rejected.run({});assert.equal(f.record.modePublished,undefined);
 const tool=f.runtime.wrapTool({name,async run(){f.session[mode].finalizedAt=new Date().toISOString();return {success:true,published:true};}});
 await tool.run({});assert.equal(published,1);
 for await(const part of service.chat([]))assert.equal(part.type,'text');
 assert.equal(requests,0);assert.equal(f.state.telemetry.reasoner.calls,0);
});

test('browser budgets and cancellation prevent dispatch while prior accounting remains authoritative',async()=>{
 const f=fixture();let calls=0;f.state.budgets.browserActions=1;
 const tool=f.runtime.wrapTool({name:'browser_click',async run(){calls++;return {success:true};}});
 await tool.run({});assert.equal((await tool.run({})).code,'MODE_BROWSER_BUDGET');assert.equal(calls,1);
 const stopped=new AbortController();stopped.abort(new Error('Owner cancelled'));
 await assert.rejects(tool.run({},{signal:stopped.signal}),/Owner cancelled/);assert.equal(calls,1);
});

test('dependent evidence tools see durably completed browser activities before serialized ownership is released',async()=>{
 const f=fixture('founder');let done=false;
 f.record.onModeToolResult=async part=>{await new Promise(resolve=>setImmediate(resolve));assert.equal(part.toolCallId,'browser-activity');done=true;};
 const browser=f.runtime.wrapTool({name:'browser_snapshot',async run(){return {success:true};}});
 const observation=f.runtime.wrapTool({name:'record_founder_observation',async run(){assert.equal(done,true);return {success:true};}});
 const first=f.runtime.withActivity({id:'browser-activity'},()=>browser.run({}));
 const next=observation.run({});const result=await first;await next;
 assert.equal(result.evidenceActivityId,'browser-activity');assert.notEqual(result.modeEvidenceId,result.evidenceActivityId);
 assert.equal(f.state.evidence[0].activityId,'browser-activity');
});

test('mode wrappers serialize mutations and retain bounded intact evidence',async()=>{
 const f=fixture();let active=0,max=0;
 const tool=f.runtime.wrapTool({name:'browser_snapshot',async run(){active++;max=Math.max(max,active);await new Promise(resolve=>setImmediate(resolve));active--;return {success:true,url:'https://fixture.test/',bodyText:'Observed local workspace'};}});
 await f.runtime.beginTurn(new AbortController().signal);
 await Promise.all([tool.run({}),tool.run({})]);assert.equal(max,1);assert.equal(f.state.evidence.length,2);assert.ok(f.state.evidence.every(e=>e.digest));
 await f.runtime.endTurn('interrupted');assert.equal(f.state.status,'interrupted');
});

test('hostile oversized page metadata cannot expand classification checkpoints beyond their bound',async()=>{
 const f=fixture();
 const tool=f.runtime.wrapTool({name:'browser_snapshot',async run(){return {success:true,title:'x'.repeat(100000),url:'https://fixture.test/'+ 'x'.repeat(100000),assertions:Array.from({length:30},()=>({text:'x'.repeat(100000)}))};}});
 await tool.run({selector:'x'.repeat(100000)});
 assert.ok(JSON.stringify(f.state.evidence[0]).length<10000);assert.ok(JSON.stringify(f.state.actions[0].intent).length<1000);
});

test('checkpoint failure prevents browser dispatch and usage uncertainty survives restart',async()=>{
 const f=fixture('founder',{async commit(){throw new Error('Storage fixture');}});let actions=0;
 await assert.rejects(f.runtime.wrapTool({name:'browser_click',async run(){actions++;}}).run({}),/persisted/);assert.equal(actions,0);
 const g=fixture();
 g.state.modelBudget.roles.reasoner.reservations.push({id:'old',status:'uncertain',tokens:500});
 const restored=structuredClone(g.session);
 const runtime=createModeReasoningRuntime({session:restored,runStore:{async commit(){}},profile:hybridProfile({apiKey:'fixture'}),record:{}});
 await assert.rejects(runtime.beginTurn(new AbortController().signal),/unverified prior usage/);
 assert.equal(restored.sqa.execution.telemetry.reasoner.reservedTokens,500);
});

test('tool failure leaves an uncertain action which cannot be automatically replayed',async()=>{
 const f=fixture();let calls=0;
 const tool=f.runtime.wrapTool({name:'browser_click',async run(){calls++;throw new Error('Browser disconnected');}});
 await assert.rejects(tool.run({}),/Browser disconnected/);assert.equal(f.state.actions[0].status,'uncertain');
 await assert.rejects(tool.run({}),/no subsequent action/);assert.equal(calls,1);
 const service={async chat(){throw new Error('Must not dispatch');}};f.runtime.wrapChat(service);
 assert.throws(()=>service.chat([]),/no automatic replay/);
 await assert.rejects(f.runtime.beginTurn(new AbortController().signal),/no action was replayed/);assert.equal(calls,1);
});

test('a failed read-only browser observation can recover without replaying any mutation',async()=>{
 const f=fixture();let reads=0;
 const read=f.runtime.wrapTool({name:'browser_snapshot',async run(){if(++reads===1)throw new Error('Read connection lost');return {success:true,url:'https://fixture.test/',bodyText:'Verified new browser state'};}});
 await assert.rejects(read.run({}),/Read connection lost/);assert.equal(f.state.actions[0].status,'failed');
 await f.runtime.beginTurn(new AbortController().signal);assert.equal((await read.run({})).success,true);assert.equal(reads,2);
});

test('stagnant SDK responses stop while genuine evidence permits continued execution',async()=>{
 const f=fixture();
 for(let i=0;i<3;i++)assert.equal(await f.runtime.continueSegment(f.runtime.progress()),i<2);
 const before=f.runtime.progress();await f.runtime.wrapTool({name:'browser_snapshot',async run(){return {url:'https://fixture.test/',bodyText:'New feature'};}}).run({});
 assert.equal(await f.runtime.continueSegment(before),true);
});

test('advisory classifier uses intact evidence, caches unchanged inputs and cannot modify a mode verdict',async()=>{
 const f=fixture();
 await f.runtime.wrapTool({name:'browser_snapshot',async run(){return {success:true,bodyText:'Observed error'};}}).run({});
 let calls=0;f.runtime.router.classifier=async()=>{calls++;return {category:{choice:'functional'}};};
 const tool=f.runtime.tools.find(t=>t.name==='classify_mode_observations');
 const input={evidence_ids:[f.state.evidence[0].id]};
 await tool.run(input);assert.equal((await tool.run(input)).cached,true);assert.equal(calls,1);
 f.state.evidence[0].result.bodyText='tampered';await assert.rejects(tool.run(input),/intact/);
 assert.equal(f.session.sqa.assessment,undefined);
});

test('SDK summary requests preserve their own contract without mode execution context or tools',async()=>{
 const f=fixture(),service={chat(){throw new Error('Router stub owns transport');}};let seen;
 f.runtime.router.reasoner=async(_original,messages,options)=>{seen={messages,options};return(async function*(){yield {type:'text',content:'Durable summary'};})();};
 f.runtime.wrapChat(service);const request=[{role:'system',content:'Summarize the conversation.'}];
 for await(const _ of await service.chat(request,{maxOutputTokens:512})){}
 assert.deepEqual(seen.messages,request);assert.deepEqual(seen.options.tools,[]);assert.equal(seen.options.maxOutputTokens,512);
});

test('snapshot clocks cannot buy mode continuations while new surfaces and report sections count as progress',async()=>{
 const f=fixture('founder');let clock=0;
 const tool=f.runtime.wrapTool({name:'browser_snapshot',async run(){return {success:true,url:'https://fixture.test/',bodyText:`Clock ${clock++}`};}});
 await tool.run({});
 for(let i=0;i<3;i++){const before=f.runtime.progress();await tool.run({});assert.equal(await f.runtime.continueSegment(before),i<2);}
 const before=f.runtime.progress();f.session.founder.reportDraft={revision:'new-typed-section'};
 assert.equal(await f.runtime.continueSegment(before),true);
});

test('download, external-window and mutating links cannot inflate mandatory mode exploration depth',async()=>{
 const f=fixture();f.session.targetUrl='https://fixture.test/';
 const links=[{href:'/docs',label:'Documentation'},{href:'/logout',label:'Sign out'},{href:'/download.pdf',download:true},{href:'/separate',target:'_blank'},{href:'/checkout',label:'Pay'},{href:'/export.csv'},{href:'https://outside.test/'},{href:'/query?token=private'}];
 await f.runtime.wrapTool({name:'browser_snapshot',async run(){return {success:true,url:f.session.targetUrl,bodyText:'Observed home',links};}}).run({});
 assert.deepEqual(f.state.routes.map(r=>r.url),['https://fixture.test/','https://fixture.test/docs']);
 assert.equal(modeExplorationReadiness(f.session).requiredPages,2);
});
