// JEV receives a bounded choice over the planner's proposals. Keep raw page
// text, input values, credentials, URLs and free-form instructions local.
const actions = new Set(['click','type','select','press','navigate','back','scroll']);
const vocabulary = new Set(('open close toggle menu tab panel link page navigate navigation back home help search filter sort next previous select option ' +
	'enter fill form empty required invalid valid email text field input validate validation correct save submit receipt confirm ' +
	'project projects note notes item items list archived active pricing solutions account profile settings dashboard ' +
	'check checkbox button disclosure dialog modal expand collapse keyboard focus escape enter down up top bottom').split(' '));

function cues(text) {
	return [...new Set(String(text ?? '').toLowerCase().match(/[a-z]+/g) ?? [])].filter(word => vocabulary.has(word)).slice(0,12).join(' ');
}

export const isJourneyAction = call => actions.has(call.function?.name);

export async function selectJourneyAction({models,calls,goal,signal,deadline,describe}) {
	if (!models.jevAvailable?.()) return {blocked:'JEV is unavailable or its action budget is exhausted.'};
	const candidates = [];
	for (const call of calls.filter(isJourneyAction).slice(0,8)) {
		const name = call.function.name;
		let args;
		try { args = JSON.parse(call.function.arguments || '{}'); } catch { continue; }
		if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
		let control;
		if (['click','type','select'].includes(name)) {
			if (!/^e\d+$/.test(args.ref)) continue;
			control = await describe(args.ref);
		}
		const key = 'step' + candidates.length;
		candidates.push({key,call,description:[name,cues(control?.kind),cues(control?.label),cues(args.expect),cues(args.key ?? args.direction)].filter(Boolean).join(' ')});
	}
	if (!candidates.length) return {replan:true};
	const criteria = Object.fromEntries(candidates.map(c => [c.key,c.description]));
	criteria.replan = 'None of these actions fits the current goal or the available controls.';
	const ms = deadline - Date.now();
	if (ms <= 0) return {blocked:'The journey deadline expired before the action decision.'};
	const timer = AbortSignal.timeout(Math.ceil(ms));
	const decisionSignal = signal ? AbortSignal.any([signal,timer]) : timer;
	try {
		const answer = await models.decide({task:'Select one functional QA browser action',goal:cues(goal)},
			{next:{type:'choice',instructions:'Select the one proposed next step that advances the planned journey. Use replan when the choices are unsuitable.',criteria}},
			{signal:decisionSignal,purpose:'action'});
		signal?.throwIfAborted();
		if (timer.aborted) return {blocked:'The journey deadline expired before dispatch.'};
		const decision = answer?.next;
		if (decision?.type === 'choice') {
			if (decision.choice === 'replan') return {replan:true};
			const selected = candidates.find(c => c.key === decision.choice);
			if (selected) return {call:selected.call};
		}
	} catch {
		signal?.throwIfAborted();
		if (timer.aborted) return {blocked:'The journey deadline expired before dispatch.'};
	}
	return {blocked:'JEV did not return a valid action decision.'};
}
