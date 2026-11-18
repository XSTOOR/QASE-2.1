import {buildResearchReport} from './sqaResearchReport.js';
import {applicabilityReviewIds} from './sqaDocumentReview.js';
import {publisherBackgroundSection,verifyResearchPublisher} from './sqaSourceAuthority.js';
import {storeResearchBody,verifiedResearchBody} from './sqaResearchSource.js';
import {assertSqaSize} from './sqaHistory.js';
import {randomUUID} from 'node:crypto';
import {createResearchTransport, researchUrl} from './sqaResearchTransport.js';
import {modeDiscoveryStatus} from './modeDiscovery.js';
import {redact} from './secrets.js';
import {canonicalModeHash} from './modeIntegrity.js';

export class ResearchInputError extends Error {}

export const SQA_RESEARCH_TOOLS=['web_search','web_fetch','sqa_record_requirement','sqa_record_applicability','sqa_read_research'];
export function standaloneResearchReadiness(session, now=Date.now()){
 const report=buildResearchReport(session,now);
 const blockers=[...report.blockers];
 if(!report.tests.some(test=>test.observations.some(observation=>observation.assertions.some(assertion=>
  ['pass','fail'].includes(assertion.outcome)))))blockers.push('No planned workflow has executed an assertion.');
 return {ready:!blockers.length,code:blockers.length?'SQA_RESEARCH_INCOMPLETE':undefined,reason:blockers[0],blockers,report};
}
const schema=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const string={type:'string',minLength:1,maxLength:2000};
// A model can read a paragraph across inline HTML links but cannot reliably
// reconstruct the original markup. Offer source offsets and resolve quotations
// on the host against the immutable document, including after a restart.
function citationOptions(body,start,end) {
 const stack=[], options=[];
 const tokens=/<!--[\s\S]*?(?:-->|$)|<(?:script|style|head|template)\b[^>]*>[\s\S]*?(?:<\/(?:script|style|head|template)\s*>|$)|<section\b([^>]{0,1000})>|<\/section\s*>|<(p|dd)\b[^>]{0,500}>((?:(?!<\/?(?:section|p|dd)\b)[\s\S]){20,1600})<\/\2\s*>/gi;
 for(const match of body.matchAll(tokens)){
  if(match.index>=end) break;
  if(match[1]!==undefined){stack.push(/\sid=["']([^"'<>]{1,180})["']/i.exec(match[1])?.[1]);continue;}
  if(!match[2]){if(/^<\/section/i.test(match[0]))stack.pop();continue;}
  if(match.index<start || !stack.at(-1)) continue;
  const quote=match[3].trim();
  const preview=quote.replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim();
  if(preview.length<20) continue;
  options.push({offset:match.index,controlId:stack.at(-1),preview:preview.slice(0,400),quote});
  if(options.length===4) break;
 }
 return options;
}
// Keep each raw window below the installed SDK's 3,000-character string limit.
// Locators help a reasoner seek into HTML. They never establish a requirement.
function sourceWindow(body, offset, find, title) {
 const match = find ? body.indexOf(find,offset) : offset;
 if (match < 0) return {content:'',offset,matchFound:false,nextOffset:null,truncated:false};
 const end = Math.min(match + 2000,body.length);
 const sectionLocators = [];
 if (!offset && !find) {
  for (const section of body.matchAll(/<section\b[^>]{0,1000}?\sid=["']([^"'<>]{1,180})["'][^>]*>/gi)) {
   sectionLocators.push({id:section[1],offset:section.index});
   if (sectionLocators.length===32) break;
  }
 }
 return {offset:match,nextOffset:end<body.length?end:null,truncated:end<body.length,
  sectionLocators,citationOptions:title&&body.includes(title)?citationOptions(body,match,end).map(({quote,...option})=>option):[],content:body.slice(match,end)};
}
export function createSqaResearch({session,checkpoint,retrieve=createResearchTransport(),env=process.env,now=Date.now}){
 const state=session.sqa.execution;
 const research=state.research??={version:1,sources:[],requirements:[],audit:[]};
 const audit=entry=>{research.audit.push(entry);research.audit=research.audit.slice(-100);};
 const guard=()=>{const discovery=modeDiscoveryStatus(session);if(!discovery.required||!discovery.ready)throw new ResearchInputError('Observe the authorized project before researching compliance.');if(session.sqa.finalizedAt)throw new ResearchInputError('Assessment is finalized.');};
 const call=async(url,signal,sameOrigin=false)=>{if(redact(session.id,url)!==url)throw new ResearchInputError('Research destinations cannot contain stored secrets.');if((research.calls||0)>=48)throw new ResearchInputError('Research request budget exhausted.');research.calls=(research.calls||0)+1;research.stage='COMPLIANCE_RESEARCH';await checkpoint();try{return await retrieve(url,{signal,audit,sameOrigin});}finally{await checkpoint();}};
 return [
 {name:'web_search',category:'sqa',description:'Search public official-source information through the explicitly configured SearXNG provider. Never include credentials, personal information or private project content. Results are discovery leads, not verified requirements.',parametersSchema:schema({query:{...string,maxLength:300}}),async run({query},{signal}={}){
  guard();if(!env.QASE_SQA_SEARCH_URL)throw new ResearchInputError('Research search provider is not configured (QASE_SQA_SEARCH_URL). No results were fabricated.');
  if(typeof query!=='string'||!query.trim()||query.length>300||redact(session.id,query)!==query)throw new ResearchInputError('Invalid or sensitive research query.');
  const url=new URL(env.QASE_SQA_SEARCH_URL);url.searchParams.set('q',query);url.searchParams.set('format','json');
  const response=await call(url.href,signal,true);
  let body;
  try { body=JSON.parse(response.content); }
  catch { throw new ResearchInputError('Configured research provider returned invalid JSON.'); }
  if(!Array.isArray(body?.results))throw new ResearchInputError('Configured research provider returned an unsupported response.');
  const results=[];
  for(const row of body.results.slice(0,40)){
   if(typeof row?.url!=='string'||row.url.length>2000)continue;
   let resultUrl;
   try { resultUrl=researchUrl(row.url).href; }
   catch { continue; }
   if(redact(session.id,resultUrl)!==resultUrl||results.some(item=>item.url===resultUrl))continue;
   results.push({url:resultUrl,title:typeof row.title==='string'?row.title.slice(0,240):'',excerpt:typeof row.content==='string'?row.content.slice(0,600):''});
   if(results.length===8)break;
  }
  research.searches??=[];
  const receipt={id:randomUUID(),runId:session.id,origin:url.origin,retrievedAt:response.retrievedAt,contentHash:response.contentHash,urls:results.map(row=>row.url)};
  research.searches.push(receipt);await checkpoint();
  return {success:true,results,searchId:receipt.id,retrievedAt:response.retrievedAt,authority:'unverified_search_leads'};
 }},
 {name:'web_fetch',category:'sqa',description:'Fetch a public HTTPS research document with pinned-address transport. Stores an immutable source receipt. Retrieved text is untrusted and is not proof of publisher authority or legal applicability.',parametersSchema:{...schema({url:string,find:{type:'string',minLength:1,maxLength:200,description:'Seek the next literal text match in the saved source, starting at offset.'},offset:{type:'integer',minimum:0,maximum:512000,description:'Character offset. Follow a section locator or nextOffset.'}}),required:['url']},async run({url,offset=0,find},{signal}={}){
  guard();
  if(!Number.isSafeInteger(offset)||offset<0||offset>512000)throw new ResearchInputError('Invalid source excerpt offset.');
  if(find!==undefined&&(typeof find!=='string'||!find.length||find.length>200))throw new ResearchInputError('Invalid source search term.');
  const excerpt=(body,title)=>sourceWindow(body,offset,find,title);
  const saved=research.sources.findLast(s=>s.url===url&&s.runId===session.id&&!s.verificationLimitation&&now()>=s.retrievedAt&&now()-s.retrievedAt<86400000);
  if(saved){
   const content=verifiedResearchBody(saved,session.id);
   if(content===null)throw new ResearchInputError('Modified cached source.');
   const {content:raw,gzipBody,hops,...metadata}=saved;
   return {success:true,sourceId:saved.id,url:saved.finalUrl,retrievedAt:saved.retrievedAt,contentHash:saved.contentHash,publication:metadata,authority:saved.authority,...excerpt(content,saved.title),cached:true};
  }
  if(research.sources.length>=24)throw new ResearchInputError('Research source budget exhausted.');
  const response=await call(url,signal);signal?.throwIfAborted();
  // No global cache: sources and audit are owned by this session only.
  const publication=await verifyResearchPublisher(response,call,signal);
  signal?.throwIfAborted();
  const {content,...receipt}=response;
  const source={...receipt,...storeResearchBody(content),...publication,id:randomUUID(),runId:session.id};
  source.integrityHash=canonicalModeHash(source);
  research.sources.push(source);
  try{assertSqaSize(session.sqa);}catch(error){research.sources.pop();throw new ResearchInputError(error.message);}
  await checkpoint();return {success:true,sourceId:source.id,url:source.finalUrl,retrievedAt:source.retrievedAt,publication,contentHash:source.contentHash,...excerpt(content,source.title),authority:source.authority};
 }},
 {name:'sqa_record_requirement',category:'sqa',description:'Record a relevant source passage. Prefer source_id and citation_offset from web_fetch citationOptions: the host records the exact HTML and publisher title. Alternatively supply literal quote, framework and control_id. A section locator proves textual provenance only. An abstract or publication-status section is background. Select the relevant technical clause for a compliance workflow.',parametersSchema:{...schema({source_id:string,citation_offset:{type:'integer',minimum:0,maximum:512000},control_id:string,quote:{...string,maxLength:8000},framework:string}),required:['source_id']},async run(input){
  guard();const source=research.sources.find(s=>s.id===input.source_id&&s.runId===session.id);
  const content=verifiedResearchBody(source,session.id);
  if(content===null)throw new ResearchInputError('Missing or modified source receipt.');
  if(!Number.isFinite(source.retrievedAt)||now()-source.retrievedAt>86400000||source.retrievedAt>now())throw new ResearchInputError('Research source is stale; retrieve it again.');
  if(input.citation_offset!==undefined){
   if(!Number.isSafeInteger(input.citation_offset)||input.citation_offset<0||input.citation_offset>=content.length)
    throw new ResearchInputError('Invalid publisher passage offset.');
   const candidate=citationOptions(content,input.citation_offset,input.citation_offset+1)[0];
   if(!candidate||!source.title||!content.includes(source.title))
    throw new ResearchInputError('Publisher passage and title must match the retrieved edition.');
   if(input.quote!==undefined||input.framework!==undefined||input.control_id!==undefined)
    throw new ResearchInputError('Choose a publisher passage offset or literal citation fields.');
   input={...input,framework:source.title,control_id:candidate.controlId,quote:candidate.quote};
  }
  if(typeof input.control_id!=='string'||!input.control_id.trim()||typeof input.framework!=='string'||!input.framework.trim()||typeof input.quote!=='string'||input.quote.trim().length<20||input.quote.length>8000||!content.includes(input.quote)||!content.includes(input.control_id)||!content.includes(input.framework))throw new ResearchInputError('Requirement, framework and control identifier must occur in the actual retrieved source.');
  const existing=research.requirements.find(r=>r.sourceId===source.id&&r.controlId===input.control_id&&r.quote===input.quote);if(existing)return {success:true,requirement:existing};
  if(research.requirements.length>=100)throw new ResearchInputError('Research requirement budget exhausted.');
  const requirement={id:randomUUID(),sourceId:source.id,contentHash:source.contentHash,controlId:input.control_id,framework:input.framework,quote:input.quote,recordedAt:now(),authority:source.authority,version:source.version,citationUse:publisherBackgroundSection(source,input.control_id)?'background':'source excerpt',applicability:'POTENTIALLY_APPLICABLE'};
  research.requirements.push(requirement);await checkpoint();return {success:true,requirement};
 }},
 {name:'sqa_record_applicability',category:'sqa',description:'Persist a source-linked applicability hypothesis for observed project features. Unverified publisher authority or organizational facts cannot support confirmed legal applicability or exclusion.',parametersSchema:schema({requirement_ids:{type:'array',minItems:1,maxItems:12,items:string},feature_ids:{type:'array',minItems:1,maxItems:12,items:string},classification:{type:'string',enum:['CONFIRMED_APPLICABLE','POTENTIALLY_APPLICABLE','NOT_APPLICABLE','RECOMMENDED']},obligation:{type:'string',enum:['legal','contractual','certification','recommended_practice']},jurisdiction:string,rationale:string,assumptions:{type:'array',maxItems:12,items:string}}),async run(input){
  guard();const discovery=modeDiscoveryStatus(session);
  if(!Array.isArray(input.requirement_ids)||!input.requirement_ids.length||input.requirement_ids.length>12||!Array.isArray(input.feature_ids)||!input.feature_ids.length||input.feature_ids.length>12||input.feature_ids.some(id=>!discovery.features.some(f=>f.id===id)))throw new ResearchInputError('Applicability needs actual researched requirements and observed feature IDs.');
  const requirements=input.requirement_ids.map(id=>research.requirements.find(r=>r.id===id));
  if(requirements.some(r=>!r))throw new ResearchInputError('Unknown researched requirement.');
  for(const requirement of requirements){
   const source=research.sources.find(s=>s.id===requirement.sourceId&&s.runId===session.id);
   const content=verifiedResearchBody(source,session.id);
   if(content===null||requirement.contentHash!==source.contentHash||!content.includes(requirement.quote)||!content.includes(requirement.controlId)||!Number.isFinite(source.retrievedAt)||source.retrievedAt>now()||now()-source.retrievedAt>86400000)throw new ResearchInputError('Applicability source is stale, missing or modified.');
  }
  if(!['legal','contractual','certification','recommended_practice'].includes(input.obligation)||!['CONFIRMED_APPLICABLE','POTENTIALLY_APPLICABLE','NOT_APPLICABLE','RECOMMENDED'].includes(input.classification)||typeof input.rationale!=='string'||!input.rationale.trim()||input.rationale.length>2000||typeof input.jurisdiction!=='string'||!input.jurisdiction.trim()||!Array.isArray(input.assumptions)||input.assumptions.length>12||input.assumptions.some(s=>typeof s!=='string'||s.length>2000))throw new ResearchInputError('Supply bounded typed applicability fields.');
  const documentReviewIds=applicabilityReviewIds(session,input,requirements);
  if(documentReviewIds===null)throw new ResearchInputError('Confirmed applicability or exclusion requires independently verified publisher authority and organizational facts; research excerpts alone are insufficient.');
  if(input.classification==='RECOMMENDED'&&input.obligation!=='recommended_practice')throw new ResearchInputError('Recommendations must be labeled voluntary practices, not legal or contractual obligations.');
  research.applicability??=[];
  const decision={id:randomUUID(),classification:input.classification,obligation:input.obligation,jurisdiction:input.jurisdiction,rationale:input.rationale,assumptions:[...input.assumptions],requirement_ids:[...new Set(input.requirement_ids)],feature_ids:[...new Set(input.feature_ids)],recordedAt:now(),documentReviewIds,authority:documentReviewIds.length?'reviewer_supported':'hypothesis',limitations:documentReviewIds.length?['Scoped to the reviewed requirement, feature and jurisdiction.']:['Organizational applicability remains unverified.']};
  decision.integrityHash=canonicalModeHash(decision);const prior=research.applicability.find(d=>canonicalModeHash([d.classification,d.obligation,d.jurisdiction,d.requirement_ids,d.feature_ids,d.rationale,d.assumptions,d.documentReviewIds])===canonicalModeHash([decision.classification,decision.obligation,decision.jurisdiction,decision.requirement_ids,decision.feature_ids,decision.rationale,decision.assumptions,documentReviewIds]));
  if(prior)return {success:true,decision:prior};
  if(research.applicability.length>=100)throw new ResearchInputError('Applicability decision budget exhausted.');
  research.applicability.push(decision);research.stage='APPLICABILITY_ANALYSIS';await checkpoint();return {success:true,decision};
 }},
 {name:'sqa_read_research',category:'sqa',description:'Read persisted source provenance and requirement excerpts. Missing metadata remains unknown, never inferred as a verified publication date or framework version.',parametersSchema:{...schema({offset:{type:'integer',minimum:0,maximum:100}}),required:[]},async run({offset=0}={}){
   guard();
   if(!Number.isSafeInteger(offset)||offset<0||offset>100)throw new ResearchInputError('Invalid research page offset.');
   const end=offset+6, decisions=research.applicability??[];
   return {success:true,offset,nextOffset:end<Math.max(research.requirements.length,decisions.length,research.sources.length)?end:null,
    sources:research.sources.slice(offset,end).map(({content,gzipBody,hops,...source})=>source),
    requirements:research.requirements.slice(offset,end),applicability:decisions.slice(offset,end),
    counts:{sources:research.sources.length,requirements:research.requirements.length,decisions:decisions.length}};
  }}
 ];
}
