import test from 'node:test';
import assert from 'node:assert/strict';
import { renewHybridQualification } from './hybridQualification.js';

test('expired setup triggers one real renewal request and only read-only polls until host readiness',async()=>{
 const requests=[],painted=[],waits=[];
 const config=status=>({hybridQa:{status,available:status==='ready'}});let reads=0;
 const result=await renewHybridQualification({api:async(path,options)=>{requests.push({path,...options});return path.endsWith('qualification')?config('qualification_running'):config(++reads===2?'ready':'qualification_running');},onConfig:c=>painted.push(c),wait:async ms=>waits.push(ms)});
 assert.equal(result.hybridQa.available,true);
 assert.deepEqual(requests,[{path:'/config/hybrid/qualification',method:'POST',body:'{}'},{path:'/config'},{path:'/config'}]);
 assert.equal(painted.length,3);assert.deepEqual(waits,[1500,1500]);
});

test('failed and timed-out renewal never unlock the launcher or restart a paid check',async()=>{
 const paints=[];let calls=0;
 await assert.rejects(renewHybridQualification({api:async()=>{calls++;return{hybridQa:{status:'qualification_failed',available:false,reason:'Streaming could not be verified.'}};},onConfig:c=>paints.push(c)}),/Streaming/);
 assert.equal(calls,1);assert.equal(paints[0].hybridQa.available,false);
 calls=0;await assert.rejects(renewHybridQualification({api:async()=>{calls++;return{hybridQa:{status:'qualification_running',available:false}};},onConfig(){},wait:async()=>{},maxPolls:2}),/still running/);
 assert.equal(calls,3);
});

test('readiness polling tolerates an API replica with stale proof without sending another paid request',async()=>{
 const states=['qualification_running','qualification_expired','qualification_required','ready'],methods=[];
 const result=await renewHybridQualification({api:async(_path,options)=>{methods.push(options?.method||'GET');const status=states.shift();return{hybridQa:{status,available:status==='ready'}};},onConfig(){},wait:async()=>{}});
 assert.equal(result.hybridQa.available,true);assert.deepEqual(methods,['POST','GET','GET','GET']);
});
