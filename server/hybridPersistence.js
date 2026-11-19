// JSON-only persistence for QA engine state (PostgreSQL column qa_runs.hybrid_qa,
// migration 043). No credentials or SDK objects belong here.
//
// Version 1 states come from the retired hybrid SDK runtime and are kept
// read-only so old runs still open. Version 2 is the current QA engine
// (server/qa/engine.js). The finding child table predates engine metadata, so
// per-finding details (fix guidance, selector, viewports, screenshot) are
// stored here and re-attached on load.
const MAX_BYTES = 4_000_000;

export function hybridStorage(session) {
  if (session.qaExecutionMode !== 'hybrid') return null;
  if (session.mode !== 'qa') throw new TypeError('QA engine state is QA-only.');
  let state = session.hybrid || null;
  let serialized = JSON.stringify({ version: 1, executionMode: 'hybrid', state });
  if (Buffer.byteLength(serialized) > MAX_BYTES && state?.version === 2) {
    // Candidates are working data; the published findings and report are durable elsewhere.
    state = { ...state, candidates: state.candidates.slice(0, 200), pages: undefined, links: undefined };
    serialized = JSON.stringify({ version: 1, executionMode: 'hybrid', state });
  }
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new TypeError('QA engine state exceeds its durable storage budget.');
  return serialized;
}

export function hydrateHybrid(session, stored) {
  if (!stored) return;
  if (session.mode !== 'qa' || stored.version !== 1 || stored.executionMode !== 'hybrid' || (stored.state && ![1, 2].includes(stored.state.version))) throw new TypeError('Unsupported QA engine state.');
  session.qaExecutionMode = 'hybrid';
  if (!stored.state) return;
  session.hybrid = structuredClone(stored.state);
  for (const finding of session.findings || []) {
    const details = stored.state.findingDetails?.[finding.id];
    if (details) Object.assign(finding, structuredClone(details));
    // Version 1 runs linked findings to host-attested evidence.
    const attestation = stored.state.confirmedFindings?.find(item => item.findingId === finding.id);
    if (attestation) finding.hybridEvidence = structuredClone(attestation.evidence);
  }
}
