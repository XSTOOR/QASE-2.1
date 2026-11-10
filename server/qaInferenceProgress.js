import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Per inference, not per SDK segment. Repeated reads, timestamps, reasoning,
 * failed schema calls and rewrites of the same disposition do not buy tokens.
 * Store bounded fingerprints, never page copy or hidden model reasoning. */
export function recordInferenceProgress(state) {
  const prior = state.inferenceProgress ??= { turns: 0, stagnantTurns: 0, seen: [] };
  const keys = [
    ...state.scenarios.flatMap(s => s.assertions.map(a => hash(['assertion',s.id,a.name,a.expected,a.actual,a.outcome]))),
    ...state.scenarios.filter(s => ['passed','failed','blocked','inconclusive','not_executed'].includes(s.status)).map(s => hash(['outcome',s.id,s.status])),
    ...(state.discovery?.features || []).map(f => hash(['feature',f.id])),
    ...(state.exploration?.routes || []).map(r => hash(['route',r.id,r.status])),
    ...state.evidence.filter(e => e.toolName === 'browser_qa_check' && !['inspect','scroll'].includes(state.actions.find(a => a.id === e.actionId)?.input?.action)).map(e => {
      const action = state.actions.find(a => a.id === e.actionId);
      return hash(['check',action?.scenarioId,action?.input,e.success,e.result?.code,e.result?.inventory?.stateKey]);
    })
  ];
  const fresh = keys.some(key => !prior.seen.includes(key));
  prior.stagnantTurns = !prior.turns || fresh ? 0 : prior.stagnantTurns + 1;
  prior.seen = [...new Set([...prior.seen,...keys])].slice(-1600);
  prior.turns++;
  return { turns: prior.turns, stagnantTurns: prior.stagnantTurns, stalled: prior.stagnantTurns >= 8 };
}
