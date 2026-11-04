// JSON-only persistence contract. No credentials or SDK objects belong here.
export function hybridStorage(session) {
  if (session.qaExecutionMode !== 'hybrid') return null;
  if (session.mode !== 'qa') throw new TypeError('Hybrid state is QA-only.');
  const value = { version: 1, executionMode: 'hybrid', state: session.hybrid || null };
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 4000000) throw new TypeError('Hybrid evidence state exceeds its durable storage budget. Checkpoint and export evidence before continuing.');
  return serialized;
}

export function hydrateHybrid(session, stored) {
  if (!stored) return;
  if (session.mode !== 'qa' || stored.version !== 1 || stored.executionMode !== 'hybrid' || (stored.state && stored.state.version !== 1)) throw new TypeError('Unsupported hybrid QA state.');
  session.qaExecutionMode = 'hybrid';
  if (stored.state) {
    session.hybrid = structuredClone(stored.state);
    // Finding/report child tables predate hybrid metadata. Reconstruct only
    // host-attested links kept in this run's bounded hybrid state.
    for (const finding of session.findings || []) {
      const attestation = stored.state.confirmedFindings?.find(item => item.findingId === finding.id);
      if (attestation) finding.hybridEvidence = structuredClone(attestation.evidence);
    }
  }
}
