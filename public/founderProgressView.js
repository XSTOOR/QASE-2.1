/** Keep the progress controls mounted across evidence and SSE updates so
 * keyboard focus and async announcements survive ordinary rendering. */
export function createFounderProgressView({root,documentRef=globalThis.document,onContinue,onReviewActivity,onAnswer,onOpenSettings}){
 if(!root)return {render(){}};
 const doc=documentRef,pending=new Set(),errors=new Map();let current,id,parts;
 function mount(){
  const title=doc.createElement('h3');title.id='founder-progress-title';title.textContent='Review progress';title.tabIndex=-1;
  const status=doc.createElement('p');status.className='founder-progress-state';
  const announcement=doc.createElement('p');announcement.className='sr-only';announcement.setAttribute('role','status');announcement.setAttribute('aria-live','polite');announcement.setAttribute('aria-atomic','true');
  const steps=doc.createElement('ol');steps.className='founder-progress-steps';steps.setAttribute('aria-label','Review stages');
  const counts=doc.createElement('p');counts.className='founder-progress-counts';
  const detail=doc.createElement('p');detail.className='founder-progress-detail';
  const activity=doc.createElement('p');activity.className='founder-progress-detail';
  const error=doc.createElement('p');error.className='founder-progress-error';error.setAttribute('role','alert');error.tabIndex=-1;
  const button=doc.createElement('button');button.type='button';button.className='btn-primary';button.dataset.founderContinue='true';
  const help=doc.createElement('button');help.type='button';help.className='btn-secondary';help.dataset.founderRecoveryHelp='true';
  button.onclick=async()=>{
   const selected=id;if(!selected||pending.has(selected)||!current?.recovery?.available)return;
   pending.add(selected);errors.delete(selected);render(current,id);
   try{await onContinue?.(selected);}catch(cause){errors.set(selected,cause instanceof Error?cause.message:String(cause));}
   finally{pending.delete(selected);render(current,id);if(id===selected&&errors.has(selected)&&[button,title].includes(doc.activeElement))error.focus();}
  };
  root.classList.add('founder-progress');root.setAttribute('aria-labelledby',title.id);
  root.replaceChildren(title,status,announcement,steps,counts,detail,activity,error,button,help);
  parts={title,status,announcement,steps,counts,detail,activity,error,button,help};
 }
 function render(progress,sessionId){
  current=progress;id=sessionId;root.hidden=!progress;
  if(!progress)return;if(!parts)mount();
  const waiting=pending.has(id),focused=doc.activeElement===parts.button;
  root.dataset.status=progress.status;
  const countText=`${progress.lenses.completed}/${progress.lenses.total} review areas${progress.report?` · ${progress.report.completed}/${progress.report.total} report sections`:''} · ${progress.browserActivities} browser actions`;
  const announcement=`${progress.title}. ${progress.lenses.completed}/${progress.lenses.total} review areas${progress.report?`, ${progress.report.completed}/${progress.report.total} report sections saved`:''}.`;
  parts.status.textContent=waiting?'Checking saved progress…':progress.title;
  if(parts.announcement.textContent!==announcement)parts.announcement.textContent=announcement;
  if(!parts.steps.childElementCount){
   for(const step of progress.stages){const item=doc.createElement('li');const label=doc.createElement('span');label.textContent=step.label;const state=doc.createElement('small');item.append(label,state);parts.steps.append(item);}
  }
  progress.stages.forEach((step,index)=>{
   const node=parts.steps.children[index];if(!node)return;
   node.dataset.status=step.status;node.lastElementChild.textContent=step.status==='complete'?'Saved':step.status==='current'?'Current':'Pending';
   if(step.status==='current')node.setAttribute('aria-current','step');else node.removeAttribute('aria-current');
  });
  parts.counts.textContent=countText;parts.detail.textContent=progress.detail;
  parts.activity.textContent=progress.currentActivity?`Current action: ${progress.currentActivity}`:'';parts.activity.hidden=!progress.currentActivity;
  const errorText=errors.get(id)||progress.lastError||'';parts.error.textContent=errorText;parts.error.hidden=!errorText;
  parts.button.hidden=!progress.recovery?.available&&!waiting;
  parts.button.disabled=waiting;parts.button.textContent=waiting?'Resuming…':progress.recovery?.label||'Continue review';
  parts.button.setAttribute('aria-busy',String(waiting));
  const code=progress.recovery?.code;
  const helper=code==='INPUT_REQUIRED'?onAnswer:['CONNECTION_REQUIRED','CONNECTION_MISMATCH'].includes(code)?onOpenSettings:progress.pause?onReviewActivity:undefined;
  parts.help.hidden=!helper;parts.help.textContent=code==='INPUT_REQUIRED'?'Answer current question':['CONNECTION_REQUIRED','CONNECTION_MISMATCH'].includes(code)?'Open Settings':'View saved activity';parts.help.onclick=()=>helper?.();
  if(focused&&(parts.button.hidden||parts.button.disabled))parts.title.focus({preventScroll:true});
 }
 return {render};
}
