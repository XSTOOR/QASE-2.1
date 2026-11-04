import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { createRedisEventTransport } from './redisEvents.js';

test('real Redis isolates tenants, delivers cross-replica cancellation/frames, bounds stale frames and reconnects subscribers', {skip:!process.env.QASE_TEST_REDIS_URL,timeout:15000},async t=>{
 const url=process.env.QASE_TEST_REDIS_URL, tenant=Object.freeze({organizationId:randomUUID(),projectId:randomUUID()});
 const clients=[];
 const create=(scope=tenant)=>{
  const publisher=createClient({url}),subscriber=publisher.duplicate();clients.push({publisher,subscriber});
  return createRedisEventTransport({tenantContext:scope,url,publisher,subscriber});
 };
 const worker=create(), api=create(), outsider=create(Object.freeze({...tenant,projectId:randomUUID()}));
 t.after(()=>Promise.allSettled([worker.close(),api.close(),outsider.close()]));
 await Promise.all([worker.load(),api.load(),outsider.load()]);
 const id=randomUUID(), received=[],other=[];
 await api.subscribe(id,e=>received.push(e));await outsider.subscribe(id,e=>other.push(e));
 const wait=async predicate=>{const until=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<until,'real Redis delivery deadline');await new Promise(r=>setTimeout(r,10));}};
 worker.publish({type:'status',sessionId:id,status:'running'});await wait(()=>received.length===1);
 assert.equal(await api.check(),true);
 for(let n=0;n<200;n++)worker.publish({type:'frame',sessionId:id,frame:{data:`fixture-${n}`}});
 await wait(()=>api.getLiveState(id).frame?.data==='fixture-199');
 assert.ok(received.filter(e=>e.type==='frame').length<200,'newest pending frame replaces stale queued images');
 worker.publish({type:'status',sessionId:id,status:'interrupted'});await wait(()=>received.some(e=>e.status==='interrupted'));
 assert.equal(other.length,0);assert.equal(api.getLiveState(id).running,false);
 // Terminate only this test's Redis client, never the server or other clients.
 const sub=clients[1].subscriber;sub.destroy();await sub.connect();
 await sub.subscribe(`qase:v1:${tenant.organizationId}:${tenant.projectId}:events`,message=>{
   const envelope=JSON.parse(message);if(envelope.event.status==='done')received.push(envelope.event);
 });
 worker.publish({type:'status',sessionId:id,status:'done'});await wait(()=>received.some(e=>e.status==='done'));
 assert.equal(other.length,0);
});
