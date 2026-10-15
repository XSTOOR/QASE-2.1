/** Observe the current browser before report verification or runtime teardown. */
export async function captureRuntimeFacts(session, bridge, record = {}) {
	if (!bridge) return session.runtimeFacts ?? null;
	let facts;
	try { facts = await bridge.readRuntimeFacts?.(); }
	catch { return session.runtimeFacts ?? null; }
	if (!facts) return session.runtimeFacts ?? null;
	session.runtimeFacts = {
		...facts,
		executionLevel: bridge.execution?.level ?? facts.executionLevel ?? session.executionLevel ?? null,
		provider: bridge.execution?.provider ?? facts.provider ?? null,
		emulatedUserAgent: bridge.execution?.emulatedUserAgent ?? facts.emulatedUserAgent ?? null,
		launchedEngineId: bridge.execution?.launchedEngineId ?? facts.launchedEngineId ?? null,
		brandedBinary: bridge.runtimeFacts?.brandedBinary ?? facts.brandedBinary ?? null,
		runtimeSessionId: record.deviceSessionId ?? facts.runtimeSessionId ?? session.runtimeFacts?.runtimeSessionId ?? null,
		attestation: record.deviceSession?.attestation ?? facts.attestation ?? session.runtimeFacts?.attestation ?? null,
		capturedAt: new Date().toISOString()
	};
	return session.runtimeFacts;
}
