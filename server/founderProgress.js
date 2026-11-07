import { canonicalModeHash } from './modeIntegrity.js';
import { founderFinishReadiness } from './founderTools.js';
import { founderDraftProgress, usesFounderDraft, FOUNDER_REPORT_SECTIONS } from './founderReportDraft.js';
import { sanitizeErrorDetail } from './errorSanitizer.js';
import { founderInvestigationIntact } from './founderInvestigation.js';

const stages=[['scope','Scope saved'],['exploration','Explore product'],['evidence','Record review areas'],['report','Write report'],['publication','Publish report']];
const pause=(code,title,message)=>({code,title,message});

export function founderRecoveryToken(session){
 return canonicalModeHash({id:session.id,status:session.status,detail:session.statusDetail,
  scope:session.founder.scope,observations:session.founder.observations,
  draft:session.founder.reportDraft,investigation:session.founder.investigationCheckpoint?.revision,finalizedAt:session.founder.finalizedAt,todos:session.todos,
  pending:session.pendingQuestion?.toolCallId,activities:session.activities?.map(a=>[a.id,a.status]),
  usage:session.tokenUsage,execution:session.founder.execution});
}

/** Server-owned progress and admission policy. No timers, model prose, or
 * completed todo alone can establish evidence coverage or publication. */
export function buildFounderProgress(session,{running=false,resuming=false,stopping=false,configReady=true,provider}={}){
 if(session?.mode!=='founder'||!session.founder)return undefined;
 const founder=session.founder,completed=Boolean(founder.finalizedAt&&founder.report);
 const draft=founderDraftProgress(session),staged=usesFounderDraft(session);
 const readiness=completed?null:founderFinishReadiness(session);
 const reviewed=completed?founder.report.coverage?.categoriesReviewed?.length||founder.scope?.categories?.length||0:readiness.reviewed.length;
 const total=completed?founder.report.coverage?.totalCategories||founder.scope?.categories?.length||17:readiness.total;
 const browser=(session.activities||[]).filter(a=>a.status==='done'&&a.toolName?.startsWith('browser_'));
 const busy=Boolean(!completed&&(running||resuming||stopping||['running','queued'].includes(session.status)));
 let phase=completed?'complete':!session.targetUrl?'scope':draft.completed.length?'report'
  :!readiness.inventoryComplete||!readiness.representativeWorkflowComplete||!readiness.browserEvidenceComplete?'exploration'
   :readiness.missing.length||readiness.incompleteTodos.length||!readiness.contextDecisionRecorded||readiness.authenticationDecisionRequired?'evidence':'report';
 if(!completed&&staged&&!draft.next)phase='publication';
 const sectionCount=completed&&staged?FOUNDER_REPORT_SECTIONS.length:draft.completed.length;
 const active=(session.activities||[]).findLast(a=>a.status==='running');
 const generation=founder.reportGeneration,state=founder.execution;
 let reason;
 if(completed)reason=pause('COMPLETE','Report published','Your published report and evidence are available.');
 else if(founder.finalizedAt)reason=pause('PUBLISHED_STATE_MISSING','Saved report needs review','The run is marked published but its report is missing. Review stored run data before continuing.');
 else if(busy)reason=pause('BUSY',stopping?'Stopping review':running||session.status==='running'?'Review running':'Resuming saved review','Wait for the active work to finish, or stop this run first.');
 else if(session.pendingQuestion||session.status==='awaiting_input')reason=pause('INPUT_REQUIRED',session.pendingQuestion?.credentialLike?'Test account needed':'Your answer is needed','Answer the current question or use the secure account form before continuing.');
 else if(generation&&(generation.version!==1||generation.protocol!=='section-draft-v1'||generation.evidenceHashVersion!==1))reason=pause('PROTOCOL_UNSUPPORTED','Saved review needs its original runtime','This report uses an unsupported saved protocol. Restore its compatible runtime before continuing.');
 else if(state?.strategy&&state.strategy!=='qualified-opus-jev-v1')reason=pause('STRATEGY_UNSUPPORTED','Saved review needs its original runtime','Restore the compatible execution strategy before continuing this saved review.');
 else if(generation&&provider==='jev')reason=pause('CONNECTION_MISMATCH','Restore the report connection','Choose a configured generative model connection in Settings. The bounded JEV controller cannot resume this staged report.');
 else if(!draft.intact)reason=pause('DRAFT_CHANGED','Saved evidence needs review','Report content or its evidence changed after saving. Review the checkpoint; existing sections will not be overwritten.');
 else if(!founderInvestigationIntact(session))reason=pause('INVESTIGATION_CHANGED','Saved investigation needs review','Saved page facts or their browser activities changed. Review the checkpoint before continuing.');
 else if((session.activities||[]).some(a=>a.status==='running')||state?.actions?.some(a=>['running','uncertain'].includes(a.status)))reason=pause('ACTION_UNCERTAIN','An earlier action needs review','An action has no confirmed result. Review its saved activity before resuming; it will not be replayed automatically.');
 else if(state&&(['reasoner','classifier'].some(role=>state.telemetry?.[role]?.reservedTokens>0)||Object.values(state.modelBudget?.roles||{}).some(role=>role.legacyCalls>0||role.reservations?.some(r=>['pending','uncertain'].includes(r.status)))))reason=pause('USAGE_UNVERIFIED','Provider usage needs reconciliation','A model request has no verified usage receipt. Saved progress is preserved; reconcile provider usage before resuming.');
 else if(state?.budgets&&((state.telemetry?.elapsedMs||0)>=state.budgets.durationMs||['reasoner','classifier'].some(role=>{
  const metric=state.telemetry?.[role];return metric&&((metric.calls||0)>=state.budgets[`${role}Calls`]||(metric.inputTokens||0)+(metric.outputTokens||0)>=state.budgets[`${role}Tokens`]);
 })))reason=pause('BUDGET_REACHED','Approved limit reached','Review saved evidence and remaining scope. Continuing cannot increase this run’s approved limits.');
 else if(!configReady)reason=pause('CONNECTION_REQUIRED','Model connection needs attention','Open Settings and configure a working model connection before continuing.');
 else if(!session.targetUrl||founder.scope?.authorization?.confirmed!==true)reason=pause('SCOPE_REQUIRED','Review scope needs attention','Supply the authorized target and permission before continuing.');
 else if(!browser.length&&!founder.observations?.length&&!founder.reportDraft)reason=pause('NOT_STARTED','Review has not started','Start the review from its saved scope.');
 const stopped=Boolean(!completed&&!busy&&!session.pendingQuestion&&session.status!=='awaiting_input');
 const recoverable=stopped&&!reason;
 const label=phase==='publication'?'Publish saved report':phase==='report'?'Continue report':'Continue review';
 const status=completed?'complete':busy?'running':session.pendingQuestion||session.status==='awaiting_input'?'waiting':'paused';
 const title=completed?'Founder brief complete':busy?(stopping?'Stopping review':resuming&&!running&&session.status!=='running'?'Resuming saved review':phase==='report'?'Writing report':phase==='publication'?'Publishing report':phase==='evidence'?'Recording review areas':'Exploring product'):reason?.title||(phase==='report'||phase==='publication'?'Report writing paused':'Review paused');
 const detail=completed?'Your complete report is published.':busy?stopping?'Stopping without discarding saved progress.':'Saved evidence and completed steps are retained.':reason?.message||`${reviewed}/${total} review areas${staged?` and ${sectionCount}/${FOUNDER_REPORT_SECTIONS.length} report sections`:''} remain saved. Continue from this progress.`;
 const stepIndex=phase==='complete'?stages.length:stages.findIndex(([id])=>id===phase);
 return {version:1,phase,status,title,detail,busy,finalized:completed,
  stages:stages.map(([id,label],index)=>({id,label,status:index<stepIndex?'complete':index===stepIndex?'current':'pending'})),
  lenses:{completed:reviewed,total},report:staged?{completed:sectionCount,total:FOUNDER_REPORT_SECTIONS.length,next:draft.next,revision:draft.revision,recommendations:draft.recommendations}:null,
  browserActivities:browser.length,currentActivity:active?String(active.label||active.toolName||'Browser action').slice(0,200):null,
  lastError:session.status==='error'&&session.statusDetail?sanitizeErrorDetail(session.statusDetail).slice(0,600):undefined,
  pause:stopped&&reason?reason:null,recovery:{available:recoverable,label,token:founderRecoveryToken(session),code:reason?.code,reason:recoverable?undefined:reason?.message||'Answer the current question first.'}};
}

export function founderContinuationTask(progress){
 return ['report','publication'].includes(progress.phase)
  ?'Continue the saved Founder report from its durable checkpoint. Preserve all saved sections, observations, access/context decisions and cumulative usage. Write only the next advertised section, correct rejected fields using the tool guidance, then publish the exact complete draft_revision. Do not repeat browser work.'
  :'Continue the authorized Founder review from its saved plan, browser evidence and observations. Preserve access/context decisions and cumulative usage. Snapshot the current page before new interaction; do not replay completed actions. Complete only remaining scoped workflows, record missing review lenses in evidence-backed batches, and publish through the advertised report tools. Ask only for genuinely blocking input.';
}
