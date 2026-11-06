import {createHash} from 'node:crypto';
import {redact} from './secrets.js';
import {assertNoNumericPromise} from './founderSchema.js';
import {canonicalModeHash} from './modeIntegrity.js';

export const FOUNDER_DRAFT_PROTOCOL='section-draft-v1';
export const FOUNDER_REPORT_SECTIONS=['executive_summary','icp','positioning','monetization','recommendations','marketing','sales','risks','quick_wins','plan','metrics'];
export const usesFounderDraft=session=>session.mode==='founder'&&(session.founder?.execution?.reportProtocol===FOUNDER_DRAFT_PROTOCOL||session.founder?.reportGeneration?.protocol===FOUNDER_DRAFT_PROTOCOL);

/** Select only for a new configured-provider run. Execution strategy, existing
 * drafts and previously executed legacy runs are never silently migrated. */
export function initializeFounderReportGeneration(session,provider){
 const saved=session.founder?.reportGeneration;
 if(saved&&(saved.version!==1||saved.protocol!==FOUNDER_DRAFT_PROTOCOL||saved.evidenceHashVersion!==1))throw new TypeError('Unsupported saved Founder report protocol. Restore its supported runtime before continuing.');
 if(saved&&provider==='jev')throw new TypeError('This saved Founder report requires a configured model provider; the bounded JEV runtime cannot resume its staged report.');
 if(session.mode!=='founder'||!session.founder||provider==='jev'||session.founder.execution||session.founder.reportGeneration||session.founder.reportDraft||session.founder.finalizedAt||session.activities?.length||session.founder.observations?.length||session.tokenUsage?.totalTokens>0||session.messages?.some(m=>['agent','assistant'].includes(m.role)))return false;
 session.founder.reportGeneration={version:1,protocol:FOUNDER_DRAFT_PROTOCOL,evidenceHashVersion:1};
 return true;
}

/** Project only report tool schemas. The SDK still owns inference, tool
 * execution, permission checks and usage capture; no model or loop is replaced. */
export function founderDraftTools(session,tools,schema,{synthesis=false}={}){
 if(!usesFounderDraft(session))return tools;
 const progress=founderDraftProgress(session);
 return tools.filter(tool=>{
  if(tool.name==='draft_founder_report_section')return synthesis&&progress.intact&&Boolean(progress.next);
  if(tool.name==='finish_founder_review')return synthesis&&progress.intact&&!progress.next;
  return true;
 }).map(tool=>tool.name==='draft_founder_report_section'?{...tool,parametersSchema:founderDraftSchema(session,schema)}:tool.name==='finish_founder_review'?{...tool,parametersSchema:{...tool.parametersSchema,properties:{draft_revision:{type:'string',enum:[progress.revision]}}}}:tool);
}

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const draftHash=(session,value)=>(session.founder.execution?.evidenceHashVersion===1||session.founder.reportGeneration?.evidenceHashVersion===1)?canonicalModeHash(value):hash(value);
const source=session=>draftHash(session,session.founder.observations);
const complete=(draft,key)=>Object.hasOwn(draft?.input||{},key)&&(key!=='recommendations'||draft.input.recommendations.length>=3);

// A bounded subset of the unchanged report schema: every required field stays
// present. Constrain verbosity at the typed interface, not by omitting lenses
// or allowing incomplete reports. Legacy drafts keep their original contract.
function sectionSchema(session,schema,key){
 const bound=node=>{
  if(node.type==='string')return {...node,maxLength:Math.min(node.maxLength||400,400)};
  if(node.type==='array')return {...node,maxItems:Math.max(node.minItems||0,Math.min(node.maxItems||3,3)),items:bound(node.items)};
  if(node.type==='object')return {...node,properties:Object.fromEntries(Object.entries(node.properties||{}).map(([name,value])=>[name,bound(value)]))};
  return node;
 };
 const original=schema.properties[key];
 if(!session.founder.execution?.discovery&&!session.founder.reportGeneration)return original;
 return key==='executive_summary'?{...original,maxLength:1200}:bound(original);
}

// Validate only the subset of JSON Schema authored by founderReportToolSchema.
// The existing report normalizer remains the authoritative semantic validator.
function validate(value,schema,label){
 const type=Array.isArray(value)?'array':value===null?'null':typeof value;
 if(schema.type&&type!==schema.type)throw new TypeError(`${label} requires ${schema.type}.`);
 if(schema.enum&&!schema.enum.includes(value))throw new TypeError(`${label} has an invalid enum value.`);
 if(type==='object'){
  for(const key of schema.required||[])if(value[key]===undefined)throw new TypeError(`${label}.${key} is required.`);
  for(const [key,item] of Object.entries(value)){
   if(!Object.hasOwn(schema.properties||{},key))throw new TypeError(`${label}.${key} is not a report field.`);
   validate(item,schema.properties[key],`${label}.${key}`);
  }
 }else if(type==='array'){
  const minimum=schema.minItems??(/(?:evidence_observation_ids|assumptions|dependencies)$/.test(label)?0:1);
  if(value.length<minimum||value.length>(schema.maxItems??50))throw new TypeError(`${label} has an invalid item count.`);
  value.forEach((item,index)=>validate(item,schema.items,`${label}[${index}]`));
 }else if(type==='string'&&(!value.trim()||value.length>(schema.maxLength||5000)))throw new TypeError(`${label} requires bounded nonempty text (maximum ${schema.maxLength||5000} characters).`);
}

export function founderDraftProgress(session){
 const draft=session.founder?.reportDraft;
 return {next:FOUNDER_REPORT_SECTIONS.find(key=>!complete(draft,key))||null,
  completed:FOUNDER_REPORT_SECTIONS.filter(key=>complete(draft,key)),recommendations:draft?.input.recommendations?.length||0,revision:draft?.revision,
  intact:!draft||draft.source===source(session)&&draft.revision===draftHash(session,draft.input)};
}

export function founderDraftSchema(session,schema){
 const next=founderDraftProgress(session).next;
 const references=(node,name)=>{
  if(node.type==='array'){
   const ids=name==='evidence_observation_ids'?session.founder.observations.map(o=>o.id):name==='quick_wins'?session.founder.reportDraft?.input.recommendations?.map(r=>r.id):undefined;
   return {...node,items:{...references(node.items),...(ids?{enum:[...new Set(ids)]}:{})}};
  }
  if(node.type==='object')return {...node,properties:Object.fromEntries(Object.entries(node.properties||{}).map(([key,item])=>[key,references(item,key)]))};
  return node;
 };
 const bounded=next?references(sectionSchema(session,schema,next),next):{};
 const value=next==='recommendations'?{...bounded,minItems:1,maxItems:1}:bounded;
 return {type:'object',additionalProperties:false,properties:{section:{type:'string',enum:next?[next]:FOUNDER_REPORT_SECTIONS},value,replace_revision:{type:'string',...(session.founder.reportDraft?{enum:[session.founder.reportDraft.revision]}:{})}},required:['section','value']};
}

export function resolveFounderDraft(session,input){
 const draft=session.founder?.reportDraft,progress=founderDraftProgress(session);
 if(!draft||progress.next||!progress.intact||input?.draft_revision!==draft.revision)throw new TypeError('A complete intact Founder draft and exact revision are required. No report was published.');
 return structuredClone(draft.input);
}

export function createFounderDraftTool(session,runStore,schema,{isCancelled=()=>false,canDraft=()=>true}={}){
 let tail=Promise.resolve();
 return {name:'draft_founder_report_section',category:'founder',description:'Persist the next typed Founder report section. Write one concise sentence per scalar, and 1–3 focused items per list within the advertised limits. Recommendations append ONE item per call until three are saved; use stable distinct IDs. Cite observation evidence and label hypotheses. This is never publication; the original complete report validator still applies at finish.',
  parametersSchema:{type:'object',additionalProperties:false,properties:{section:{type:'string',enum:FOUNDER_REPORT_SECTIONS},value:{},replace_revision:{type:'string'}},required:['section','value']},
  run(input){
   const pending=tail.then(()=>save(input));tail=pending.catch(()=>{});return pending;
  }};
 async function save(input){
   if(isCancelled()||['cancelled','done'].includes(session.status)||session.founder.finalizedAt)return {success:false,error:'This run cannot accept another report draft.'};
   const old=session.founder.reportDraft;
   try{
    if(!canDraft())throw new TypeError('Complete the Founder exploration, evidence and plan prerequisites before drafting.');
    const progress=founderDraftProgress(session);
    if(!progress.intact)throw new TypeError('Draft evidence or content changed. Review the saved checkpoint; no section was overwritten.');
    if(!Object.hasOwn(schema.properties,input?.section))throw new TypeError('Unknown Founder report section.');
    const value=redact(session.id,input.value);
    const appendRecommendation=input.section==='recommendations'&&progress.next==='recommendations';
    // A retried delivery of the third recommendation is still the same saved
    // append even though the next section has advanced to marketing.
    if(input.section==='recommendations'&&Array.isArray(value)&&value.length===1){
     const duplicate=old?.input.recommendations?.find(item=>item.id===value[0]?.id);
     if(duplicate){if(draftHash(session,duplicate)===draftHash(session,value[0]))return {success:true,cached:true,...progress};throw new TypeError('Recommendation IDs must be distinct; saved items were not replaced.');}
    }
    const allowed=sectionSchema(session,schema,input.section);
    validate(value,appendRecommendation?{...allowed,minItems:1,maxItems:1}:allowed,input.section);
    const ids=new Set(session.founder.observations.map(o=>o.id));
    const evidenceCheck=(node)=>{
     if(!node||typeof node!=='object')return;
     if(Array.isArray(node.evidence_observation_ids)&&node.evidence_observation_ids.some(id=>!ids.has(id))){
      const error=new TypeError('Draft references unknown observation evidence. Copy valid IDs exactly from the advertised schema; never combine or repair IDs by guessing.');
      error.invalidObservationIds=[...new Set(node.evidence_observation_ids.filter(id=>!ids.has(id)))];throw error;
     }
     if(Array.isArray(node.evidence_observation_ids)&&!node.evidence_observation_ids.length&&!node.assumptions?.length)throw new TypeError('Each strategic claim requires observation evidence or explicit assumptions.');
     if(node.intended_outcome)assertNoNumericPromise(node.intended_outcome,'Founder intended outcome');
     for(const item of Object.values(node))if(item&&typeof item==='object')evidenceCheck(item);
    };evidenceCheck(value);
    if(input.section==='quick_wins'&&value.some(id=>!session.founder.reportDraft.input.recommendations.some(r=>r.id===id)))throw new TypeError('Quick wins must reference saved recommendation IDs.');
    if(!appendRecommendation&&old&&Object.hasOwn(old.input,input.section)){
     if(draftHash(session,old.input[input.section])===draftHash(session,value))return {success:true,cached:true,...progress};
     if(input.replace_revision!==old.revision)throw new TypeError('Correcting a saved section requires its exact replace_revision.');
    }
    else if(input.section!==progress.next)throw new TypeError(`Draft the next required section: ${progress.next}.`);
    const payload={...(old?.input||{}),[input.section]:appendRecommendation?[...(old?.input.recommendations||[]),value[0]]:value};
    const next={version:1,source:source(session),input:payload,revision:draftHash(session,payload),updatedAt:Date.now()};
    if(JSON.stringify({...session.founder,reportDraft:next}).length>=1000000)throw new TypeError('Founder state size limit reached.');
    session.founder.reportDraft=next;
    await runStore.commit(session,'founder.report_draft',{section:input.section,revision:next.revision});
    return {success:true,...founderDraftProgress(session)};
   }catch(error){
    session.founder.reportDraft=old;
    return {success:false,error:error.message,...(error.invalidObservationIds?{code:'FOUNDER_DRAFT_UNKNOWN_EVIDENCE',invalid_observation_ids:error.invalidObservationIds,allowed_observation_ids:session.founder.observations.map(o=>o.id)}:{})};
   }
  }
}
