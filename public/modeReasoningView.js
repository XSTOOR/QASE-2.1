/** Only host-persisted execution metadata is presented. Model prose and private
 * reasoning are never progress or completion authority. */
export function modeReasoningSummary(session) {
 const state=session?.[session.mode]?.execution;
 const standalone=session?.mode==='sqa'&&state?.strategy==='sqa-single-reasoner-v1';
 if(state?.strategy!=='qualified-opus-jev-v1'&&!standalone) {
  if(session?.mode!=='sqa')return [];
  return [session.sqa?.requestedExecutionStrategy==='sqa-single-reasoner-v1'?'Standalone SQA · awaiting runtime':'Legacy SQA'];
 }
 const usage=role=>{
  const metric=state.telemetry?.[role]||{};
  return `${Number(metric.calls)||0} calls · ${(Number(metric.inputTokens)||0)+(Number(metric.outputTokens)||0)} provider-reported tokens`;
 };
 const routes=state.routes||[];
 const workflows=state.workflows||[];
 const discovery=state.discovery;
 return [standalone?'SQA review · single reasoning model':'Autonomous review · Opus 4.7 + JEV 1.13',
  `Host execution: ${String(state.status||'starting').replace(/_/g,' ')} · ${Number(state.telemetry?.browserActions)||0} browser actions`,
  `${routes.filter(r=>r.reviewed).length}/${routes.length} observed pages reviewed · sampled coverage`,
  ...(discovery?[`Application discovery: ${discovery.status} · ${discovery.receipts?.length||0} observed states`,
   `Workflow dispositions: ${workflows.filter(w=>['passed','failed','blocked','inconclusive'].includes(w.status)).length}/${workflows.length} · ${workflows.filter(w=>w.status==='passed').length} verified passes · ${workflows.filter(w=>w.status==='failed').length} failures`,
   ...(session.mode==='sqa'?[`Control dispositions: ${session.sqa.observations?.length||0}/${session.sqa.scope?.applicableControlIds?.length||0}. Workflow completion does not establish evidence completeness or compliance.`]:[])]:[]),
  `Opus: ${usage('reasoner')}`,...(standalone?[
   `Research: ${state.research?.stage||'not started'} · ${state.research?.sources?.length||0} retrieved sources · ${state.research?.requirements?.length||0} source-linked excerpts. Publisher authority and applicability require separate verification.`,
   `Applicability decisions: ${state.research?.applicability?.length||0} · Plan revisions: ${state.research?.planRevisions?.length||0} · Document reviews: ${state.research?.documentReviews?.length||0}`,
   ...((state.research?.sources||[]).slice(-3).map(source=>[source.publisher,source.title||source.finalUrl,source.version,source.authority].filter(Boolean).join(' · ')).filter(Boolean))
  ]:[`JEV: ${usage('classifier')}`]),
  ...(state.pauseReason?['Progress saved. Review the latest execution message before resuming.']:[])];
}

export function renderModeReasoning(session, doc=globalThis.document) {
 const lines=modeReasoningSummary(session);if(!lines.length)return null;
 const section=doc.createElement('section');section.className='sqa-notice';
 for(const [index,line]of lines.entries()){
  const element=doc.createElement(index===0?'strong':'p');element.textContent=line;section.append(element);
 }
 return section;
}
