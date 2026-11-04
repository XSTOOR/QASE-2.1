import assert from 'node:assert/strict';
import test from 'node:test';
import { guardFinalization } from './finalizationGuard.js';
import { createSqaState } from './sqaService.js';
import { createSqaTools } from './sqaTools.js';
import { createFounderTools } from './founderTools.js';
import { createQaTools } from './qaTools.js';

for (const [mode, factory] of [['qa',createQaTools],['sqa',createSqaTools],['founder',createFounderTools]]) test(`${mode} cancelled finalizer cannot publish even an existing artifact`, async () => {
  const session = { mode, report: {ts:1}, [mode]: { finalizedAt:'fixture', assessment:{}, report:{} } };
  let commits=0;
  const finalizer=factory(session,{async commit(){commits++;}},{isCancelled:()=>true}).at(-1);
  assert.equal((await finalizer.run({})).code,'RUN_CANCELLED');
  const signal=AbortSignal.abort();
  assert.equal((await factory(session,{async commit(){commits++;}}).at(-1).run({}, {signal})).code,'RUN_CANCELLED');
  assert.equal(commits,0);
});

test('SQA duplicate publication waits for the durable write; failed commit never becomes already-finalized success', async () => {
  const session={mode:'sqa', activities:[], todos:[], sqa:createSqaState({authorizationConfirmed:true,profiles:['core'],attributes:['web_application'],target:{name:'Fixture',release:'test',environment:'local'}})};
  session.sqa.scope.applicableControlIds=['SQA-WEB-001'];
  session.sqa.observations=[{controlId:'SQA-WEB-001',status:'blocked',rationale:'Fixture server unavailable',evidence:[]}];
  session.todos=[{id:'technical',text:'Collect browser evidence',status:'completed'},{id:'publish',text:'Finish SQA assessment',status:'in_progress'}];
  let rejectCommit, began;
  const entered=new Promise(resolve=>{began=resolve;});
  const store={async commit(){began(); await new Promise((_,reject)=>{rejectCommit=reject;});}};
  const first=createSqaTools(session,store).at(-1).run({}); await entered;
  let returned=false;
  const second=createSqaTools(session,store).at(-1).run({}).then(result=>{returned=true;return result;});
  await new Promise(resolve=>setImmediate(resolve)); assert.equal(returned,false);
  rejectCommit(new Error('Injected durable storage failure'));
  assert.equal((await first).success,false); assert.equal((await second).success,false);
  assert.equal(session.sqa.finalizedAt,undefined);
  assert.equal(session.todos[1].status,'in_progress');
  const retried=await createSqaTools(session,{async commit(){}}).at(-1).run({});
  assert.equal(retried.published,true);
  assert.equal(session.todos[1].status,'completed');
});

test('finalization guard releases its flight after thrown errors and rechecks cancellation before dispatch',async()=>{
  const session={}; let calls=0, cancelled=false;
  const tool=guardFinalization({async run(){calls++;throw new Error('Fixture failure');}},session,{isCancelled:()=>cancelled});
  await assert.rejects(tool.run({}),/Fixture failure/);
  const pending=tool.run({});cancelled=true;
  assert.equal((await pending).code,'RUN_CANCELLED');assert.equal(calls,1);
});
