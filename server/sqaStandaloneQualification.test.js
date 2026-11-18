import test from 'node:test';
import assert from 'node:assert/strict';
import {hybridProfile,profileIdentity} from './hybridConfig.js';
import {SQA_STANDALONE_STRATEGY} from './sqaStandaloneStrategy.js';
import {validateStandaloneQualification,standaloneProfileIdentity,SQA_STANDALONE_CAPABILITIES} from './sqaStandaloneQualification.js';
test('standalone qualification cannot reuse hybrid receipts or omit executable evidence',()=>{
 const profile=hybridProfile({apiKey:'fixture'}),now=Date.now();
 const receipt={strategy:SQA_STANDALONE_STRATEGY,profileIdentity:standaloneProfileIdentity(profile),sdkVersion:profile.sdkVersion,checkedAt:now,jevCalls:0,runId:'test-fixture',capabilities:Object.fromEntries(SQA_STANDALONE_CAPABILITIES.map(name=>[name,{passed:true,evidenceRef:'fixture-only'}]))};
 assert.equal(validateStandaloneQualification(profile,receipt,now),true);
 for(const patch of [{profileIdentity:profileIdentity(profile)},{strategy:'qualified-opus-jev-v1'},{checkedAt:now-86400001},{checkedAt:now+1},{jevCalls:1},{capabilities:{}}])assert.throws(()=>validateStandaloneQualification(profile,{...receipt,...patch},now),/unqualified/);
 assert.throws(()=>validateStandaloneQualification(hybridProfile({apiKey:'other-account'}),receipt,now),/unqualified/);
 const missing=structuredClone(receipt);delete missing.capabilities.research.evidenceRef;
 assert.throws(()=>validateStandaloneQualification(profile,missing,now),/unqualified/);
});

test('changing the approved search provider invalidates standalone qualifications',()=>{
 const p=hybridProfile({apiKey:'fixture'});
 assert.notEqual(standaloneProfileIdentity(p,{QASE_SQA_SEARCH_URL:'https://a.example/search'}),standaloneProfileIdentity(p,{QASE_SQA_SEARCH_URL:'https://b.example/search'}));
});
