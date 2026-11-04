import {createHash} from 'node:crypto';
import {redact} from './secrets.js';
import {assertNoNumericPromise} from './founderSchema.js';

export const FOUNDER_DRAFT_PROTOCOL='section-draft-v1';
export const FOUNDER_REPORT_SECTIONS=['executive_summary','icp','positioning','monetization','recommendations','marketing','sales','risks','quick_wins','plan','metrics'];
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const source=session=>hash(session.founder.observations);
const complete=(draft,key)=>Object.hasOwn(draft?.input||{},key)&&(key!=='recommendations'||draft.input.recommendations.length>=3);

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
 }else if(type==='string'&&(!value.trim()||value.length>5000))throw new TypeError(`${label} requires bounded nonempty text.`);
}

export function founderDraftProgress(session){
 const draft=session.founder?.reportDraft;
 return {next:FOUNDER_REPORT_SECTIONS.find(key=>!complete(draft,key))||null,
  completed:FOUNDER_REPORT_SECTIONS.filter(key=>complete(draft,key)),recommendations:draft?.input.recommendations?.length||0,revision:draft?.revision,
  intact:!draft||draft.source===source(session)&&draft.revision===hash(draft.input)};
}

export function founderDraftSchema(session,schema){
 const next=founderDraftProgress(session).next;
 const value=next==='recommendations'?{...schema.properties.recommendations,minItems:1,maxItems:1}:next?schema.properties[next]:{};
 return {type:'object',additionalProperties:false,properties:{section:{type:'string',enum:next?[next]:FOUNDER_REPORT_SECTIONS},value,replace_revision:{type:'string',...(session.founder.reportDraft?{enum:[session.founder.reportDraft.revision]}:{})}},required:['section','value']};
}

export function resolveFounderDraft(session,input){
 const draft=session.founder?.reportDraft,progress=founderDraftProgress(session);
 if(!draft||progress.next||!progress.intact||input?.draft_revision!==draft.revision)throw new TypeError('A complete intact Founder draft and exact revision are required. No report was published.');
 return structuredClone(draft.input);
}

export function createFounderDraftTool(session,runStore,schema,{isCancelled=()=>false,canDraft=()=>true}={}){
 return {name:'draft_founder_report_section',category:'founder',description:'Persist the next typed Founder report section. Recommendations append ONE item per call until three are saved; use stable distinct IDs. Cite observation evidence and label hypotheses. This is never publication; the original complete report validator still applies at finish.',
  parametersSchema:{type:'object',additionalProperties:false,properties:{section:{type:'string',enum:FOUNDER_REPORT_SECTIONS},value:{},replace_revision:{type:'string'}},required:['section','value']},
  async run(input){
   if(isCancelled()||['cancelled','done'].includes(session.status)||session.founder.finalizedAt)return {success:false,error:'This run cannot accept another report draft.'};
   const old=session.founder.reportDraft;
   try{
    if(!canDraft())throw new TypeError('Complete the Founder exploration, evidence and plan prerequisites before drafting.');
    const progress=founderDraftProgress(session);
    if(!progress.intact)throw new TypeError('Draft evidence or content changed. Review the saved checkpoint; no section was overwritten.');
    if(!Object.hasOwn(schema.properties,input?.section))throw new TypeError('Unknown Founder report section.');
    const value=redact(session.id,input.value);
    const appendRecommendation=input.section==='recommendations'&&progress.next==='recommendations';
    validate(value,appendRecommendation?{...schema.properties.recommendations,minItems:1,maxItems:1}:schema.properties[input.section],input.section);
    const ids=new Set(session.founder.observations.map(o=>o.id));
    const evidenceCheck=(node)=>{
     if(!node||typeof node!=='object')return;
     if(Array.isArray(node.evidence_observation_ids)&&node.evidence_observation_ids.some(id=>!ids.has(id)))throw new TypeError('Draft references unknown observation evidence.');
     if(Array.isArray(node.evidence_observation_ids)&&!node.evidence_observation_ids.length&&!node.assumptions?.length)throw new TypeError('Each strategic claim requires observation evidence or explicit assumptions.');
     if(node.intended_outcome)assertNoNumericPromise(node.intended_outcome,'Founder intended outcome');
     for(const item of Object.values(node))if(item&&typeof item==='object')evidenceCheck(item);
    };evidenceCheck(value);
    if(input.section==='quick_wins'&&value.some(id=>!session.founder.reportDraft.input.recommendations.some(r=>r.id===id)))throw new TypeError('Quick wins must reference saved recommendation IDs.');
    if(appendRecommendation){
     const duplicate=old?.input.recommendations?.find(item=>item.id===value[0].id);
     if(duplicate){if(hash(duplicate)===hash(value[0]))return {success:true,cached:true,...progress};throw new TypeError('Recommendation IDs must be distinct; saved items were not replaced.');}
    }else if(old&&Object.hasOwn(old.input,input.section)){
     if(hash(old.input[input.section])===hash(value))return {success:true,cached:true,...progress};
     if(input.replace_revision!==old.revision)throw new TypeError('Correcting a saved section requires its exact replace_revision.');
    }
    else if(input.section!==progress.next)throw new TypeError(`Draft the next required section: ${progress.next}.`);
    const payload={...(old?.input||{}),[input.section]:appendRecommendation?[...(old?.input.recommendations||[]),value[0]]:value};
    const next={version:1,source:source(session),input:payload,revision:hash(payload),updatedAt:Date.now()};
    if(JSON.stringify({...session.founder,reportDraft:next}).length>=1000000)throw new TypeError('Founder state size limit reached.');
    session.founder.reportDraft=next;
    await runStore.commit(session,'founder.report_draft',{section:input.section,revision:next.revision});
    return {success:true,...founderDraftProgress(session)};
   }catch(error){session.founder.reportDraft=old;return {success:false,error:error.message};}
  }};
}
