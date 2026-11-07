import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { founderInvestigationCheckpoint,projectFounderMessages,rememberFounderEvidence,founderInvestigationIntact } from './founderInvestigation.js';

const fixture=()=>({id:'projection-fixture',mode:'founder',founder:{reportGeneration:{version:1,protocol:'section-draft-v1'},scope:{categories:['product_clarity','activation'],access:{decision:'public_only'},contextDecision:{mode:'assumptions'}},observations:[{id:'observed',category:'product_clarity',title:'Observed heading',summary:'The fixture names the product.',evidence:[{activityId:'a-1'}]}]},todos:[{text:'Map routes',status:'completed'},{text:'Exercise workflow',status:'in_progress'}],activities:[{id:'a-1',status:'done',toolName:'browser_open',input:{url:'https://fixture.test/docs?private=value#fragment'},summary:'Opened documentation'}],tokenUsage:{inputTokens:40000,outputTokens:2000}});

test('Founder checkpoint carries durable progress, remaining lenses and safe route paths without treating todos as evidence',()=>{
 const session=fixture();session.founder.observations.push({id:'unverified',category:'activation',summary:'Unsupported'});
 const checkpoint=founderInvestigationCheckpoint(session);
 assert.deepEqual(checkpoint.remainingLenses,['activation']);assert.deepEqual(checkpoint.observedRoutes,['https://fixture.test/docs']);
 assert.equal(checkpoint.approvedAccess,'public_only');assert.equal(checkpoint.contextSource,'assumptions');assert.deepEqual(checkpoint.plan,session.todos);
});

test('projection leaves saved state unchanged and preserves recent native tools, links and the two latest screenshots',()=>{
 const session=fixture(),messages=[{role:'system',content:'Trusted policy'},{role:'user',content:'Review the original authorized fixture.'}];
 for(let i=0;i<8;i++){
  messages.push({role:'assistant',content:'',toolCalls:[{id:`call-${i}`,toolName:'browser_snapshot',input:{}}]});
  messages.push({role:'tool',toolCallId:`call-${i}`,name:'browser_snapshot',content:JSON.stringify({success:true,url:'https://fixture.test/',bodyText:'Old page text. '.repeat(600)})});
  messages.push({role:'user',content:[{type:'image_url',image_url:{url:`data:image/png;base64,image-${i}${'x'.repeat(12000)}`}}]});
 }
 const before=structuredClone({session,messages}),projected=projectFounderMessages(messages,session);
 assert.deepEqual({session,messages},before);
 const images=projected.flatMap(m=>Array.isArray(m.content)?m.content.filter(p=>p.type==='image_url'):[]);
 assert.equal(images.length,2);assert.ok(images.at(-1).image_url.url.startsWith('data:image/png;base64,image-7'));
 for(const id of ['call-6','call-7']){
  assert.ok(projected.some(m=>m.role==='assistant'&&m.toolCalls?.some(c=>c.id===id)));
  assert.ok(projected.some(m=>m.role==='tool'&&m.toolCallId===id));
 }
 assert.ok(projected.some(m=>m.role==='user'&&m.content==='Review the original authorized fixture.'));
 assert.match(projected.at(-1).content,/remainingLenses/);assert.match(projected.at(-1).content,/Never change access/);
 assert.ok(JSON.stringify(projected).length<JSON.stringify(messages).length/2);
});

test('an unreturned native tool call and recent failure remain available for repair',()=>{
 const session=fixture(),messages=[{role:'user',content:'Review fixture'},{role:'assistant',content:'',toolCalls:[{id:'pending',toolName:'browser_click',input:{selector:'#save'}}]},{role:'assistant',content:'',toolCalls:[{id:'failed',toolName:'browser_snapshot',input:{}}]},{role:'tool',toolCallId:'failed',content:JSON.stringify({success:false,error:'A precise locator is required.'})}];
 const projected=projectFounderMessages(messages,session);
 assert.ok(projected.some(m=>m.toolCalls?.some(t=>t.id==='pending')));
 assert.ok(projected.some(m=>m.toolCallId==='failed'&&m.content===messages.at(-1).content));
});

test('only exact SDK context envelopes are deduplicated; synthesis and legacy/qualified callers keep their own contract',()=>{
 const session=fixture(),root=path.join(process.cwd(),'.qase','workspaces',session.id),context=`Workspace root: ${root}\n\nTrusted Founder instructions`;
 const messages=[{role:'user',content:`[CONTEXT]\n${context}\n\nUser Request: Original request`},{role:'system',content:`[RUNTIME CONTEXT REMINDER]\n${context}\n\nCurrent objective: Review fixture`}];
 const projected=projectFounderMessages(messages,session,{trustedContexts:[context],synthesis:true});
 assert.equal(projected[0].content,'Original request');assert.equal(projected[1].content,messages[1].content);assert.equal(projected.length,2);
 const legacy=fixture();delete legacy.founder.reportGeneration;assert.equal(projectFounderMessages(messages,legacy),messages);
 const qualified=fixture();delete qualified.founder.reportGeneration;qualified.founder.execution={reportProtocol:'section-draft-v1'};assert.equal(projectFounderMessages(messages,qualified),messages);
});

test('actual page facts and validation outcomes survive old transcript removal and checkpoint restoration',async()=>{
 const session=fixture(),store={async commit(){}};
 for(const [id,tool,result]of [['snapshot','browser_snapshot',{success:true,inventory:{url:'https://fixture.test/pricing?private=value',title:'Pricing',bodyText:'The observed price is $19 per team.'}}],['forms','browser_qa_check',{success:true,url:'https://fixture.test/practice',assertions:[{check:'Empty task is rejected',outcome:'pass',expected:'Native validation blocks submit',actual:'valueMissing; no network request'}]}]]){
  session.activities.push({id,toolName:tool,status:'done',input:{action:tool==='browser_qa_check'?'forms':undefined}});
  assert.equal(await rememberFounderEvidence(session,store,{toolName:tool,activityId:id,result}),true);
 }
 const restored=JSON.parse(JSON.stringify(session));assert.equal(founderInvestigationIntact(restored),true);
 const projected=projectFounderMessages([{role:'user',content:'Continue from saved work.'}],restored);
 assert.match(projected.at(-1).content,/\$19 per team/);assert.match(projected.at(-1).content,/valueMissing/);assert.match(projected.at(-1).content,/"activityId":"forms"/);
 assert.ok(!JSON.stringify(restored.founder.investigationCheckpoint).includes('private=value'));
 restored.founder.investigationCheckpoint.entries[0].text='Changed';assert.equal(founderInvestigationIntact(restored),false);
});

test('failed persistence, unconfirmed activities and other execution strategies cannot replace saved investigation memory',async()=>{
 const session=fixture();session.activities.push({id:'snapshot',toolName:'browser_snapshot',status:'done'});
 const input={toolName:'browser_snapshot',activityId:'snapshot',result:{success:true,inventory:{url:'https://fixture.test/',bodyText:'Observed workspace'}}};
 await assert.rejects(rememberFounderEvidence(session,{async commit(){throw new Error('Storage unavailable');}},input),/Storage unavailable/);
 assert.equal(session.founder.investigationCheckpoint,undefined);
 session.activities.at(-1).status='running';assert.equal(await rememberFounderEvidence(session,{},input),false);
 const legacy=fixture();delete legacy.founder.reportGeneration;assert.equal(await rememberFounderEvidence(legacy,{},input),false);
});

test('repeated snapshots stay bounded while distinct diagnostic outcomes remain available',async()=>{
 const session=fixture();let commits=0;const store={async commit(){commits++;}};
 const snapshot={success:true,inventory:{url:'https://fixture.test/',bodyText:'Observed workspace'}};
 for(const id of ['snap-1','snap-2']){session.activities.push({id,toolName:'browser_snapshot',status:'done'});await rememberFounderEvidence(session,store,{toolName:'browser_snapshot',activityId:id,result:snapshot});}
 assert.equal(session.founder.investigationCheckpoint.entries.length,1);assert.equal(session.founder.investigationCheckpoint.entries[0].activityId,'snap-2');
 assert.equal(await rememberFounderEvidence(session,store,{toolName:'browser_snapshot',activityId:'snap-2',result:snapshot}),false);assert.equal(commits,2);
 for(const [id,console]of [['diag-error',[{level:'error',message:'Fixture failure'}]],['diag-healthy',[]]]){session.activities.push({id,toolName:'browser_diagnostics',status:'done'});await rememberFounderEvidence(session,store,{toolName:'browser_diagnostics',activityId:id,result:{success:true,url:'https://fixture.test/',console,network:[]}});}
 assert.equal(session.founder.investigationCheckpoint.entries.length,3);assert.equal(founderInvestigationIntact(session),true);
});
