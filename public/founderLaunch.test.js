import test from 'node:test';
import assert from 'node:assert/strict';
import { founderLaunchProblems } from './founderLaunch.js';
import { createFounderState } from '../server/founderService.js';
import { founderFinishReadiness } from '../server/founderTools.js';

const launch = overrides => ({ setupVersion:1, authorizationConfirmed:true, targetUrl:'https://fixture.test/',
  target:{name:'Fixture',url:'https://fixture.test/'}, environmentId:'env-fixture', accessDecision:'public_only', contextMode:'assumptions', ...overrides });

test('Founder readiness rejects missing prerequisites and unsafe URLs while public assumptions can start',()=>{
  assert.deepEqual(founderLaunchProblems(launch()),[]);
  for(const targetUrl of ['', 'fixture.test', 'javascript:alert(1)', 'https://user:password@fixture.test/']) assert.ok(founderLaunchProblems(launch({targetUrl})).some(message=>message.includes('target URL')));
  assert.ok(founderLaunchProblems(launch({environmentId:''})).some(message=>message.includes('device and browser')));
  assert.ok(founderLaunchProblems(launch({authorizationConfirmed:false})).some(message=>message.includes('permission')));
  assert.ok(founderLaunchProblems(launch({catalogReady:false})).some(message=>message.includes('catalog')));
});

test('supplied business context needs all four fields; assumptions do not require invented context',()=>{
  assert.equal(founderLaunchProblems(launch({contextMode:'provided'})).length,4);
  const productContext={stage:'beta',businessModel:'Subscription',targetCustomer:'Small teams',primaryGoal:'Improve first task completion'};
  assert.deepEqual(founderLaunchProblems(launch({contextMode:'provided',productContext})),[]);
  assert.throws(()=>createFounderState(launch({contextMode:'provided',productContext:{primaryGoal:'Launch'}})),/product stage/);
  const founder=createFounderState(launch());
  assert.equal(founder.scope.access.decision,'public_only');
  assert.equal(founder.scope.contextDecision.mode,'assumptions');
  assert.deepEqual(founder.scope.productContext,{});
  const readiness=founderFinishReadiness({mode:'founder',founder,activities:[],todos:[],messages:[],secretNames:[]});
  assert.equal(readiness.contextDecisionRecorded,true,'The upfront choice is durable without requiring browser observations or chat heuristics.');
});

test('authenticated setup respects execution capability and HTTPS without silently changing scope',()=>{
  assert.ok(founderLaunchProblems(launch({accessDecision:'authenticated',authenticatedAvailable:false})).some(message=>message.includes('unavailable')));
  assert.ok(founderLaunchProblems(launch({accessDecision:'authenticated',targetUrl:'http://fixture.test/'})).some(message=>message.includes('HTTPS')));
  assert.deepEqual(founderLaunchProblems(launch({accessDecision:'authenticated',targetUrl:'http://127.0.0.1/'})),[]);
  assert.throws(()=>createFounderState(launch({accessDecision:'authenticated',authenticatedAvailable:false})),/unavailable/);
  const founder=createFounderState(launch({accessDecision:'authenticated'}));
  assert.equal(founder.scope.access.authenticatedSurfaces,'requested');
});
