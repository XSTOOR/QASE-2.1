import test from 'node:test';
import assert from 'node:assert/strict';
import {createResearchTransport,publicResearchAddress,pinnedResearchRequest} from './sqaResearchTransport.js';
import https from 'node:https';
import {EventEmitter} from 'node:events';

test('research rejects encoded IPv4, private IPv6, mapped addresses, metadata and reserved ranges',async()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','100.64.1.1','224.0.0.1','192.0.2.1','::1','fe80::1','fc00::1','::ffff:8.8.8.8','64:ff9b::1','2001:db8::1','2002:7f00:1::'])assert.equal(publicResearchAddress(ip),false,ip);
 for(const url of ['https://2130706433','https://0x7f000001','https://0177.0.0.1','https://[::1]','https://user:secret@example.com','http://example.com','https://example.com:444'])await assert.rejects(createResearchTransport()(url));
});
test('each redirect is validated before connection and rebinding cannot change the pinned address',async()=>{
 let resolutions=0;const calls=[];
 const get=createResearchTransport({resolveHost:async()=>{resolutions++;return [{address:resolutions===1?'8.8.8.8':'127.0.0.1'}];},request:async(url,address)=>{calls.push(address);return {status:302,location:'/next'};}});
 await assert.rejects(get('https://example.com'),/DNS/);assert.deepEqual(calls,['8.8.8.8']);
 const privateRedirect=createResearchTransport({resolveHost:async()=>[{address:'8.8.8.8'}],request:async()=>({status:302,location:'https://169.254.169.254/latest'})});
 await assert.rejects(privateRedirect('https://example.com'),/private/);
});
test('loops, response limits, connection errors and cancellation fail closed',async()=>{
 const base={resolveHost:async()=>[{address:'8.8.8.8'}]};
 await assert.rejects(createResearchTransport({...base,request:async()=>({status:302,location:'/'})})('https://example.com'),/loop/);
 await assert.rejects(createResearchTransport({...base,request:async()=>({status:200,body:'too big'})})('https://example.com',{maxBytes:2}),/size limit/);
 await assert.rejects(createResearchTransport({...base,request:async()=>{throw new Error('connection failed');}})('https://example.com'),/connection failed/);
 const controller=new AbortController();controller.abort(new Error('cancelled'));
 await assert.rejects(createResearchTransport(base)('https://example.com',{signal:controller.signal}),/cancelled/);
 const during=new AbortController();const promise=createResearchTransport({...base,request:async()=>new Promise(()=>{})})('https://example.com',{signal:during.signal});
 during.abort(new Error('cancel during request'));await assert.rejects(promise,/cancel during/);
});
test('actual Node transport pins socket IP, retains TLS/Host identity and cannot forward caller cookies',async()=>{
 const original=https.request;let options;
 https.request=(input,respond)=>{options=input;const req=new EventEmitter();req.end=()=>{const res=new EventEmitter();res.statusCode=200;res.headers={'content-type':'text/plain'};respond(res);queueMicrotask(()=>{res.emit('data',Buffer.from('Official document'));res.emit('end');});};return req;};
 try{
  const result=await pinnedResearchRequest(new URL('https://example.com/standard'),'8.8.8.8',{signal:new AbortController().signal,maxBytes:100,cookie:'secret',authorization:'secret'});
  assert.equal(options.hostname,'8.8.8.8');assert.equal(options.servername,'example.com');assert.equal(options.headers.Host,'example.com');assert.equal(options.agent,false);assert.equal(options.rejectUnauthorized,true);
  assert.equal(options.headers.Cookie,undefined);assert.equal(options.headers.Authorization,undefined);assert.equal(options.lookup,undefined);
  assert.equal(result.body,'Official document');
 }finally{https.request=original;}
});
test('sources have content hashes and per-request audit without shared caches',async()=>{
 const audits=[];const get=createResearchTransport({resolveHost:async()=>[{address:'8.8.8.8'}],request:async()=>({status:200,type:'text/plain',body:'Observed source'}),now:()=>123});
 const result=await get('https://example.com',{audit:a=>audits.push(a)});
 assert.equal(result.contentHash.length,64);assert.equal(result.retrievedAt,123);assert.equal(audits.length,1);
});

test('search preserves the approved provider boundary and surfaces HTTP rate limits',async()=>{
 const calls=[];
 const transport=createResearchTransport({resolveHost:async()=>[{address:'8.8.8.8'}],request:async url=>{calls.push(url.origin);return {status:302,location:'https://elsewhere.test/'};}});
 await assert.rejects(transport('https://search.test/',{sameOrigin:true}),/outside its approved origin/);
 assert.deepEqual(calls,['https://search.test']);
 const limited=createResearchTransport({resolveHost:async()=>[{address:'8.8.8.8'}],request:async()=>({status:429})});
 await assert.rejects(limited('https://search.test/'),/HTTP 429/);
});
