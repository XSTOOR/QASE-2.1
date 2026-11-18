import test from 'node:test';
import assert from 'node:assert/strict';
import {modeReasoningSummary} from './modeReasoningView.js';
test('standalone research UI reports persisted counts without implying verified authority',()=>{
 const text=modeReasoningSummary({mode:'sqa',sqa:{execution:{strategy:'sqa-single-reasoner-v1',research:{stage:'COMPLIANCE_RESEARCH',sources:[{}],requirements:[{},{}]}}}}).join('\n');
 assert.match(text,/single reasoning model/);assert.match(text,/1 retrieved sources/);assert.match(text,/2 source-linked excerpts/);assert.match(text,/require separate verification/);assert.doesNotMatch(text,/JEV|100%|compliant/);
});
test('mode status shows actual saved strategy and verified usage without presenting verdicts or private state',()=>{
 const s={mode:'sqa',sqa:{execution:{strategy:'qualified-opus-jev-v1',status:'interrupted',pauseReason:'private provider detail',hiddenReasoning:'not for display',routes:[{reviewed:true},{}],telemetry:{browserActions:7,reasoner:{calls:2,inputTokens:100,outputTokens:10},classifier:{calls:1,inputTokens:20,outputTokens:2}}}}};
 const text=modeReasoningSummary(s).join('\n');assert.match(text,/110 provider-reported tokens/);assert.match(text,/1\/2 observed pages/);assert.match(text,/Progress saved/);assert.doesNotMatch(text,/private provider|not for display|PASS/);
});
test('legacy and QA screens do not acquire another mode status panel',()=>{
 assert.deepEqual(modeReasoningSummary({mode:'founder',founder:{}}),[]);assert.deepEqual(modeReasoningSummary({mode:'qa',hybrid:{}}),[]);
});

test('SQA status distinguishes legacy runs from queued standalone runs',()=>{
 assert.deepEqual(modeReasoningSummary({mode:'sqa',sqa:{}}),['Legacy SQA']);
 assert.deepEqual(modeReasoningSummary({mode:'sqa',sqa:{requestedExecutionStrategy:'sqa-single-reasoner-v1'}}),['Standalone SQA · awaiting runtime']);
});
