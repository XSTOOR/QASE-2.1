import https from 'node:https';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { createHash } from 'node:crypto';
import { isPrivateOrReservedAddress } from './browserPolicy.js';

const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
const specialV6 = new BlockList(); specialV6.addSubnet('2001::', 23, 'ipv6');
export function publicResearchAddress(address) {
 const family=isIP(address);
 return Boolean(family && !isPrivateOrReservedAddress(address) && (family===4 || globalV6.check(address,'ipv6')&&!specialV6.check(address,'ipv6')));
}
export function researchUrl(value) {
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443')throw new Error('Research requires credential-free HTTPS on port 443.');
 const host=url.hostname.replace(/^\[|\]$/g,'');
 if(!host.includes('.')&&!isIP(host)||/(?:^|\.)(?:localhost|local|internal|home\.arpa)$/.test(host)||host.endsWith('.'))throw new Error('Research destination is not a public hostname.');
 if(isIP(host)&&!publicResearchAddress(host))throw new Error('Research destination is private or reserved.');
 url.hash='';return url;
}
async function abortable(work,signal) {
 signal.throwIfAborted();let stop;
 try{return await Promise.race([work,new Promise((_,reject)=>{stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true});})]);}
 finally{signal.removeEventListener('abort',stop);}
}

// Connect directly to the validated address. DNS is never repeated by the
// socket, redirects are never followed by Node, and TLS verifies the URL host.
export function pinnedResearchRequest(url,address,{signal,maxBytes}) {
 return new Promise((resolve,reject)=>{
  const host=url.hostname.replace(/^\[|\]$/g,'');
  const req=https.request({hostname:address,port:443,path:url.pathname+url.search,method:'GET',agent:false,
   family:isIP(address),servername:isIP(host)?undefined:host,rejectUnauthorized:true,
   checkServerIdentity:(_name,cert)=>tls.checkServerIdentity(host,cert),signal,
   headers:{Host:url.host,Accept:'text/html, text/plain, application/json','Accept-Encoding':'identity','User-Agent':'QASE-Research/1.0'}},res=>{
   if([301,302,303,307,308].includes(res.statusCode)){res.destroy();resolve({status:res.statusCode,location:res.headers.location});return;}
   if(res.statusCode<200||res.statusCode>=300){res.destroy();resolve({status:res.statusCode});return;}
   const type=String(res.headers['content-type']||'').split(';')[0].trim().toLowerCase();
   if(!['text/html','text/plain','application/json','application/hal+json','application/xhtml+xml'].includes(type)||res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){reject(new Error('Unsupported research content type or encoding.'));res.destroy();return;}
   if(Number(res.headers['content-length'])>maxBytes){reject(new Error('Research response exceeds size limit.'));res.destroy();return;}
   let bytes=0;const chunks=[];
   res.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBytes){reject(new Error('Research response exceeds size limit.'));res.destroy();return;}chunks.push(chunk);});
   res.on('error',reject);res.on('aborted',()=>reject(new Error('Research response interrupted.')));
   res.on('end',()=>resolve({status:res.statusCode,type,body:Buffer.concat(chunks).toString('utf8'),bytes}));
  });
  req.on('error',reject);req.end();
 });
}

/** Dependencies are injectable for deterministic tests, never model arguments. */
export function createResearchTransport({resolveHost=host=>dns.lookup(host,{all:true,verbatim:true}),request=pinnedResearchRequest,now=Date.now}={}) {
 return async function retrieve(value,{signal,timeoutMs=15000,maxBytes=512000,audit=()=>{},sameOrigin=false}={}) {
  const active=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(Math.min(30000,Math.max(1,timeoutMs)))]);
  maxBytes=Math.min(512000,Math.max(1,maxBytes));
  let url=researchUrl(value);const origin=url.origin;const seen=new Set(),hops=[];
  try{
   for(let redirects=0;redirects<=4;redirects++){
    active.throwIfAborted();if(seen.has(url.href))throw new Error('Research redirect loop.');seen.add(url.href);
    const host=url.hostname.replace(/^\[|\]$/g,'');
    const answers=isIP(host)?[{address:host}]:await abortable(resolveHost(host),active);
    if(!Array.isArray(answers)||!answers.length||answers.some(a=>!publicResearchAddress(a.address)))throw new Error('Research DNS resolved to a private, reserved or invalid address.');
    const address=answers[0].address;
    const response=await abortable(request(url,address,{signal:active,maxBytes}),active);
    const hop={url:url.href,address,status:response.status,at:now()};hops.push(hop);audit(hop);
    if([301,302,303,307,308].includes(response.status)){
     if(!response.location||redirects===4)throw new Error('Research redirect limit or missing destination.');
     url=researchUrl(new URL(response.location,url).href);
     if(sameOrigin&&url.origin!==origin)throw new Error('Search provider redirected outside its approved origin.');
     continue;
    }
    if(response.status<200||response.status>=300)throw new Error(`Research HTTP ${response.status}.`);
    if(typeof response.body!=='string'||Buffer.byteLength(response.body)>maxBytes)throw new Error('Research response exceeds size limit.');
    active.throwIfAborted();
    return {url:value,finalUrl:url.href,retrievedAt:now(),contentType:response.type,content:response.body,contentHash:createHash('sha256').update(response.body).digest('hex'),hops};
   }
  }catch(error){audit({url:url.href,at:now(),error:String(error.message).slice(0,300)});throw error;}
 };
}
