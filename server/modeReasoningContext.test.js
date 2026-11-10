import test from 'node:test';
import assert from 'node:assert/strict';
import { projectModeMessages,compactModeEnvelopes,buildModeExecutionContext } from './modeReasoningContext.js';
import {createSqaState} from './sqaService.js';
import {buildSqaContext} from './sqaPrompt.js';
import path from 'node:path';

test('mode inference compacts complete rounds without orphaning results or losing human scope', () => {
  const messages=[{role:'system',content:'Trusted host policy'},{role:'user',content:'Authorized fixture only'}];
  for(let n=0;n<12;n++) messages.push({role:'assistant',content:'',toolCalls:[{id:`call-${n}`,toolName:'browser_snapshot',input:{}}]}, {role:'tool',toolCallId:`call-${n}`,content:JSON.stringify({url:'https://fixture.test/',bodyText:'x'.repeat(6000),modeEvidenceId:`e-${n}`})});
  messages.push({role:'assistant',content:'',toolCalls:[{id:'pending',toolName:'browser_click',input:{}}]});
  const original=structuredClone(messages), session={mode:'founder',todos:[{text:'Review workflow',status:'completed'}],founder:{observations:[{id:'observed',category:'onboarding',summary:'Local action completed'}],execution:{routes:[{url:'https://fixture.test/',reviewed:true}]}}};
  const result=projectModeMessages(messages,session);
  assert.deepEqual(messages,original);assert.equal(result[0],messages[0]);assert.equal(result[1],messages[1]);
  const calls=result.flatMap(m=>m.toolCalls||[]).map(c=>c.id);
  assert.ok(calls.includes('pending'));assert.equal(calls.length,5);
  for(const message of result.filter(m=>m.role==='tool')) assert.ok(calls.includes(message.toolCallId));
  assert.equal(result.find(m=>m.toolCallId==='call-11').content,messages.find(m=>m.toolCallId==='call-11').content);
  assert.match(result.at(-1).content,/observed/);assert.match(result.at(-1).content,/completed/);
  assert.ok(JSON.stringify(result).length<JSON.stringify(messages).length/2);
});

test('recent screenshots survive and inference never mutates the durable transcript', () => {
 const messages=Array.from({length:5},(_,n)=>({role:'user',content:[{type:'text',text:`Capture ${n}`},{type:'image_url',image_url:{url:`data:image/png;base64,fixture${n}`}}]}));
 const result=projectModeMessages(messages);
 assert.equal(result.filter(m=>m.content.some(p=>p.type==='image_url')).length,2);
 assert.equal(messages.filter(m=>m.content.some(p=>p.type==='image_url')).length,5);
 assert.equal(result[0].content[0].text,'Capture 0');
});

test('SQA inference keeps only the current workflow result and latest screenshot', () => {
	const messages=[];
	for(let n=0;n<6;n++) messages.push(
		{role:'assistant',content:'',toolCalls:[{id:`sqa-${n}`,toolName:'browser_snapshot',input:{}}]},
		{role:'tool',toolCallId:`sqa-${n}`,content:JSON.stringify({success:true,bodyText:'x'.repeat(5000)})},
		{role:'user',content:[{type:'image_url',image_url:{url:`data:image/png;base64,sqa${n}`}}]}
	);
	const session={mode:'sqa',todos:[],sqa:{observations:[],execution:{}}};
	const result=projectModeMessages(messages,session);
	const calls=result.flatMap(message=>message.toolCalls||[]).map(call=>call.id);
	assert.deepEqual(calls,['sqa-4','sqa-5']);
	assert.equal(result.filter(message=>Array.isArray(message.content)&&message.content.some(part=>part.type==='image_url')).length,1);
});

test('duplicate SDK envelopes compact only against matching trusted workspace reminders and retain every human request',()=>{
 const session={id:'mode-fixture'},context=`Workspace root: ${path.join(process.cwd(),'.qase','workspaces',session.id)}\n\n`+'Trusted mode instructions. '.repeat(1000);
 const messages=[{role:'system',content:'SDK system policy'},{role:'user',content:`[CONTEXT]\n${context}\n\nUser Request: Inspect the authorized fixture.`},{role:'system',content:`[RUNTIME CONTEXT REMINDER]\n${context}\n\nCurrent objective: Inspect the authorized fixture.`}];
 const original=structuredClone(messages),result=compactModeEnvelopes(messages,session);
 assert.equal(result[1].content,'Inspect the authorized fixture.');assert.deepEqual(result[2],original[2]);assert.deepEqual(messages,original);
 assert.ok(JSON.stringify(result).length<JSON.stringify(messages).length*.6);
 assert.deepEqual(compactModeEnvelopes(messages,{id:'different-workspace'}),messages);
});

test('a changed browser location cannot retain an obsolete full SDK context in every continuation',()=>{
 const session={id:'changing-context'},prefix=`Workspace root: ${path.join(process.cwd(),'.qase','workspaces',session.id)}\n\n`;
 const initial=prefix+'Trusted initial mode policy. '.repeat(2000),latest=prefix+'Trusted current policy and verified browser location.';
 const messages=[{role:'system',content:'SDK authority'},{role:'user',content:`[CONTEXT]\n${initial}\n\nUser Request: Preserve this exact authorized task.`},{role:'system',content:`[RUNTIME CONTEXT REMINDER]\n${latest}\n\nCurrent objective: Continue the original task.`}];
 const original=structuredClone(messages);
 const compacted=compactModeEnvelopes(messages,session,{trustedContexts:[initial]});
 assert.equal(compacted[1].content,'Preserve this exact authorized task.');assert.equal(compacted[2].content,messages[2].content);assert.deepEqual(messages,original);
 assert.ok(JSON.stringify(compacted).length<JSON.stringify(messages).length/10);
 assert.equal(compactModeEnvelopes(messages,session)[1].content,messages[1].content,'Unmatched user content cannot be guessed away.');
});

test('large recent tool results keep failed assertions and exact evidence identifiers without replaying raw payloads',()=>{
 const value={modeEvidenceId:'receipt',evidenceActivityId:'actual-browser',inventory:{url:'https://fixture.test/',bodyText:'Rendered actual page'},assertions:Array.from({length:200},(_,i)=>({name:'Check '+i,outcome:i===199?'fail':'pass',actual:'x'.repeat(200)}))};
 const message={role:'tool',toolCallId:'native-call',content:JSON.stringify(value)};
 const projected=projectModeMessages([message]);const compacted=JSON.parse(projected[0].content);
 assert.equal(compacted.modeEvidenceId,'receipt');assert.equal(compacted.evidenceActivityId,'actual-browser');assert.equal(compacted.failedAssertions[0].name,'Check 199');assert.equal(compacted.assertionCounts.total,200);
 assert.equal(message.content,JSON.stringify(value));assert.ok(projected[0].content.length<message.content.length/5);
});

test('qualified SQA phase brief retains exact reviewer requirements with less repeated legacy guidance',()=>{
 const s={mode:'sqa',targetUrl:'https://fixture.test/',activities:[],todos:[],messages:[],sqa:createSqaState({authorizationConfirmed:true,profiles:['core'],attributes:['web_application','user_interface'],target:{name:'Fixture',url:'https://fixture.test/',release:'test',environment:'isolated'}})};
 s.sqa.execution={discovery:{version:1,status:'pending'},phase:'discovery'};
 const original=buildSqaContext(s),brief=buildModeExecutionContext(s);
 assert.match(brief,/SQA-CHG-001/);assert.match(brief,/approval_record/);assert.match(brief,/BLOCKED/);assert.match(brief,/never certification/);assert.match(brief,/JEV only classifies/);assert.match(brief,/No server mutations/);
 assert.ok(brief.length<original.length,'Remove duplicated operating manuals without dropping pending controls.');
 s.sqa.observations.push({controlId:'SQA-CHG-001',status:'blocked'});
 assert.doesNotMatch(buildModeExecutionContext(s).split('Pending scoped controls')[1],/SQA-CHG-001/,'Resolved controls remain in scope but do not demand another investigation.');
});
