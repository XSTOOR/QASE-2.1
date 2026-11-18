import {readFileSync} from 'node:fs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {hybridProfile} from './hybridConfig.js';
import {researchUrl} from './sqaResearchTransport.js';
import {canonicalModeHash} from './modeIntegrity.js';
import {SQA_STANDALONE_STRATEGY} from './sqaStandaloneStrategy.js';

export function standaloneResearchProfile(settings,env=process.env) {
 return hybridProfile({...settings,apiKey:env.QASE_SQA_REASONER_API_KEY || env.QASE_API_KEY || (settings.provider !== 'jev' ? settings.apiKey : '')},env);
}

export const SQA_STANDALONE_CAPABILITIES=['sdkLoop','singleModel','zeroJev','usage','browser','research','checkpoint','continuation','cancellation','evidence','publication','terminalStates','search','fetch','sourceAuthority','dynamicPlanning','complianceExecution','exports','restart'];
export const standaloneProfileIdentity=(profile,env=process.env)=>canonicalModeHash({strategy:SQA_STANDALONE_STRATEGY,sdk:profile.sdkVersion,searchProvider:env.QASE_SQA_SEARCH_URL??null,transport:profile.usageTransport,model:profile.reasoner.model,endpoint:profile.reasoner.endpoint,credential:canonicalModeHash(profile.reasoner.apiKey)});

// Only the isolated qualification worker opens this context. Object identity
// prevents a request, another session or a serialized checkpoint from opting in.
const trialContext = new AsyncLocalStorage();
export function runStandaloneTrial(session, profile, run) {
 const target = new URL(session.targetUrl);
 if (process.env.NODE_ENV !== 'development' || process.env.QASE_LIVE_SYSTEM_QUALIFICATION !== 'true' ||
     session.mode !== 'sqa' || session.ownerUserId !== 'standalone-qualification' ||
     target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port ||
     !session.sqa?.scope.authorization.confirmed || !profile.reasoner.apiKey)
  throw new Error('A standalone trial requires an isolated development session on the loopback fixture.');
 researchUrl(process.env.QASE_SQA_SEARCH_URL);
 return trialContext.run({session, identity:standaloneProfileIdentity(profile)}, run);
}

export function requireStandaloneExecution(session, profile, env=process.env) {
 const trial = trialContext.getStore();
 if (trial && trial.session === session && trial.identity === standaloneProfileIdentity(profile,env)) return;
 loadStandaloneQualification(profile,env);
}
export function validateStandaloneQualification(profile,receipt,now=Date.now(),env=process.env){
 if(!profile.reasoner.apiKey||receipt?.strategy!==SQA_STANDALONE_STRATEGY||receipt.profileIdentity!==standaloneProfileIdentity(profile,env)||receipt.sdkVersion!==profile.sdkVersion||!Number.isFinite(receipt.checkedAt)||receipt.checkedAt>now||now-receipt.checkedAt>86400000||receipt.jevCalls!==0||!receipt.runId||SQA_STANDALONE_CAPABILITIES.some(name=>receipt.capabilities?.[name]?.passed!==true||!receipt.capabilities[name].evidenceRef))throw new Error('Standalone SQA is unqualified: a current exact-strategy SDK, research, execution and recovery qualification receipt is required. Hybrid receipts cannot enable it.');
 return true;
}
export function loadStandaloneQualification(profile,env=process.env){
 let receipt;try{receipt=JSON.parse(readFileSync(env.QASE_SQA_QUALIFICATION_FILE||'.qase/qualifications/sqa-standalone.json','utf8'));}catch{/* Fail closed below. */}
 if(!env.QASE_SQA_SEARCH_URL)throw new Error('Standalone SQA is unqualified: configure the approved QASE_SQA_SEARCH_URL.');
 researchUrl(env.QASE_SQA_SEARCH_URL);
 validateStandaloneQualification(profile,receipt,Date.now(),env);return receipt;
}

export function standaloneLaunchStatus(profile,env=process.env) {
 const enabled=env.QASE_SQA_STANDALONE_ENABLED==='true';
 const searchConfigured=Boolean(env.QASE_SQA_SEARCH_URL);
 let qualified=false;
 let blocker;
 if(!searchConfigured) blocker='The approved SearXNG endpoint (QASE_SQA_SEARCH_URL) is missing.';
 else if (!profile.reasoner.apiKey) blocker='Configure the standalone reasoning credential (QASE_SQA_REASONER_API_KEY).';
 else {
  try { researchUrl(env.QASE_SQA_SEARCH_URL); }
  catch { blocker='QASE_SQA_SEARCH_URL must be a credential-free public HTTPS endpoint.'; }
  if (!blocker) {
   try { loadStandaloneQualification(profile,env);qualified=true; }
   catch { blocker='A current standalone qualification for this configuration is required.'; }
  }
 }
 return {enabled,searchConfigured,qualified,model:profile.reasoner.model,
  strategy:SQA_STANDALONE_STRATEGY,
  blocker:blocker??(!enabled?'The standalone SQA flag is off.':undefined)};
}
