/** Serialize launch admission across HTTP awaits; never create a record when busy. */
export function createSingleRunAdmission({ matrix, orchestrator }) {
	let admitting = false;
	return async function admit(ownerUserId, launch) {
		if (admitting) return { status: 409, body: { code: 'QA_START_IN_PROGRESS', error: 'A test is already being started. Please wait a moment and try again. No additional run was created.' } };
		admitting = true;
		try {
			const runs = await matrix.list();
			const existing = runs.find(run => (run.ownerUserId ?? null) === (ownerUserId ?? null)
				&& run.kind !== 'parent' && ['pending', 'running'].includes(run.status)
				&& run.items?.some(item => ['PENDING', 'QUEUED', 'RUNNING'].includes(item.status)));
			if (existing) return { status: 200, body: { ...await matrix.get(existing.id), reused: true } };
			if (!orchestrator.canStartImmediately()) return {
				status: 503, body: { code: 'QA_CAPACITY_BUSY', error: 'The test service is busy. No run was queued. Your setup is saved here; please try again shortly.' }
			};
			return await launch();
		} finally { admitting = false; }
	};
}
