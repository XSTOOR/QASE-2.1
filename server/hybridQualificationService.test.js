import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHybridQualificationService, saveHybridQualification } from './hybridQualificationService.js';
import { hybridProfile, profileIdentity, qualificationPath, loadQualification, REQUIRED_CAPABILITIES, HYBRID_SDK_VERSION, validateQualification } from './hybridConfig.js';

const profile = hybridProfile({apiKey:'fixture-account-only'}, {});
const certificate = (p=profile, at=Date.now()) => ({passed:true,sdkVersion:HYBRID_SDK_VERSION,profileIdentity:profileIdentity(p),checkedAt:at,capabilities:Object.fromEntries(REQUIRED_CAPABILITIES.map(name=>[name,{passed:true}]))});

test('expired qualification renews all checks once; configuration reads never dispatch probes', async()=>{
 let saved=certificate(profile,Date.now()-86400001),calls=0,finish;
 const service=createHybridQualificationService({enabled:()=>true,read:p=>{validateQualification(p,saved);return saved;},save:async(_p,r)=>{saved=r;},qualify:async(_p,{signal})=>{calls++;assert.equal(signal.aborted,false);return await new Promise(resolve=>{finish=resolve;});}});
 assert.equal(service.availability(profile).status,'qualification_expired');assert.equal(calls,0);
 assert.equal(service.start(profile).status,'qualification_running');
 assert.equal(service.start(profile).status,'qualification_running');
 assert.throws(()=>service.start(hybridProfile({apiKey:'other-account'},{})),e=>e.status===429);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
 finish(certificate());await service.waitForIdle();
 assert.equal(service.availability(profile).available,true);
 service.start(profile);assert.equal(calls,1,'A current certificate is reused.');
 assert.equal(service.availability(hybridProfile({apiKey:'different-account'},{})).available,false);
});

test('failed capabilities and internal errors cannot renew, disclose credentials or trigger unbounded retries', async()=>{
 let clock=Date.now(),calls=0,writes=0;
 const service=createHybridQualificationService({enabled:()=>true,now:()=>clock,read:()=>{throw Error('Expired');},save:async()=>{writes++;},qualify:async()=>{
  calls++;if(calls===1){const report=certificate();report.passed=false;report.capabilities.streaming={passed:false,reason:'private gateway response fixture-account-only'};return report;}
  throw Error('private filesystem /credentials fixture-account-only');
 }});
 service.start(profile);await service.waitForIdle();
 const failed=service.availability(profile);assert.equal(failed.available,false);assert.equal(failed.status,'qualification_failed');assert.match(failed.reason,/streaming/);
 assert.doesNotMatch(JSON.stringify(failed),/fixture-account-only|private gateway|filesystem/);
 service.start(profile);await service.waitForIdle();assert.equal(calls,1);assert.equal(writes,0);
 clock+=60001;service.start(profile);await service.waitForIdle();assert.equal(calls,2);assert.equal(writes,0);
 assert.doesNotMatch(JSON.stringify(service.availability(profile)),/credentials|fixture-account-only/);
});

test('failed persistence, missing key and disabled mode never advertise availability', async()=>{
 const service=createHybridQualificationService({enabled:()=>true,read:()=>{throw Error('Missing');},qualify:async()=>certificate(),save:async()=>{throw Error('Private persistence failure');}});
 service.start(profile);await service.waitForIdle();assert.equal(service.availability(profile).available,false);
 assert.throws(()=>service.start(hybridProfile({},{})),e=>e.status===409);
 const disabled=createHybridQualificationService({enabled:()=>false,qualify:()=>{throw Error('Must not execute');}});
 assert.throws(()=>disabled.start(profile),e=>e.status===409);assert.equal(disabled.availability(profile).status,'disabled');
});

test('qualification is atomically replaced with private permissions and rejects mismatched credentials', async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'qase-qualification-write-')),file=path.join(root,'qualification.json');
 const previous=process.env.QASE_HYBRID_QUALIFICATION_FILE;process.env.QASE_HYBRID_QUALIFICATION_FILE=file;
 t.after(async()=>{if(previous===undefined)delete process.env.QASE_HYBRID_QUALIFICATION_FILE;else process.env.QASE_HYBRID_QUALIFICATION_FILE=previous;await fs.rm(root,{recursive:true,force:true});});
 await fs.writeFile(file,JSON.stringify(certificate(profile,Date.now()-86400001)),{mode:0o600});
 const report=certificate();await saveHybridQualification(profile,report);
 assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),report);assert.equal((await fs.stat(file)).mode&0o777,0o600);
 assert.deepEqual(await fs.readdir(root),['qualification.json']);
 await assert.rejects(saveHybridQualification(hybridProfile({apiKey:'wrong-key'},{}),report));
 assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),report);
});

test('distributed API and worker qualification paths use shared artifact storage while local and explicit paths are preserved',()=>{
 const keys=['QASE_HYBRID_QUALIFICATION_FILE','QASE_HYBRID_QUALIFICATION_DIR','QASE_EXECUTION_MODE','QASE_ARTIFACT_DIR'];
 const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 try {
  for(const key of keys)delete process.env[key];
  const suffix=`${profileIdentity(profile)}.json`;
  assert.equal(qualificationPath(profile),path.resolve('.qase/qualifications/hybrid',suffix));
  process.env.QASE_EXECUTION_MODE='distributed';process.env.QASE_ARTIFACT_DIR='/shared/evidence';
  assert.equal(qualificationPath(profile),path.resolve('/shared/evidence/qualifications/hybrid',suffix));
  process.env.QASE_HYBRID_QUALIFICATION_DIR='/operator/certificates';
  assert.equal(qualificationPath(profile),path.resolve('/operator/certificates',suffix));
  process.env.QASE_HYBRID_QUALIFICATION_FILE='/operator/fixed.json';
  assert.equal(qualificationPath(profile),'/operator/fixed.json');
 } finally {for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
});

test('distributed readers cannot fall back to a pod-local legacy certificate when shared proof is missing',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'qase-shared-proof-')),cwd=process.cwd();
 const keys=['QASE_HYBRID_QUALIFICATION_FILE','QASE_HYBRID_QUALIFICATION_DIR','QASE_EXECUTION_MODE','QASE_ARTIFACT_DIR'];
 const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 try{
  process.chdir(root);for(const key of keys)delete process.env[key];
  await fs.mkdir('.qase/qualifications',{recursive:true});await fs.writeFile('.qase/qualifications/hybrid.json',JSON.stringify(certificate()));
  assert.equal(loadQualification(profile).passed,true,'Legacy local proof remains compatible.');
  process.env.QASE_EXECUTION_MODE='distributed';process.env.QASE_ARTIFACT_DIR=path.join(root,'shared');
  assert.throws(()=>loadQualification(profile),/qualification/);
 }finally{process.chdir(cwd);for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];await fs.rm(root,{recursive:true,force:true});}
});
