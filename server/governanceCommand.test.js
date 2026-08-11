import assert from 'node:assert/strict';
import test from 'node:test';
import {
	GOVERNANCE_APPLY_ACKNOWLEDGEMENT,
	runGovernanceCommand
} from './governanceCommand.js';
import {
	AUTH_CLEANUP_ACKNOWLEDGEMENT,
	CLEANUP_ATTESTATION_ACKNOWLEDGEMENT,
	PURGE_ACKNOWLEDGEMENT
} from './postgres/retentionRepository.js';

function fixture() {
	const calls = [];
	const repository = Object.fromEntries([
		'previewRuns', 'purgeBatch', 'placeHold', 'releaseHold', 'cleanupExpiredAuth',
		'attestRunCleanup', 'recordCleanup'
	].map(method => [method, async (...args) => {
		const call = method === 'recordCleanup'
			? { method, runId: args[0], options: args[1] }
			: { method, options: args[0] };
		calls.push(call);
		return call;
	}]));
	return { repository, calls };
}

test('governance previews are read-only by construction and reject apply flags', async () => {
	const target = fixture();
	await runGovernanceCommand({
		repository: target.repository,
		environment: {
			QASE_GOVERNANCE_BATCH_SIZE: '25',
			QASE_GOVERNANCE_RETENTION_DAYS: '45',
			QASE_GOVERNANCE_POLICY_VERSION: 'customer-policy/v7'
		},
		args: ['runs-preview']
	});
	assert.deepEqual(target.calls, [{
		method: 'previewRuns', options: {
			batchSize: 25, retentionDays: 45, policyVersion: 'customer-policy/v7'
		}
	}]);
	await assert.rejects(runGovernanceCommand({
		repository: target.repository, args: ['auth-preview', '--apply']
	}), /do not accept --apply/);
});

test('mutations require the flag, exact acknowledgement, and external reference', async () => {
	for (const environment of [
		{},
		{ QASE_GOVERNANCE_ACK: GOVERNANCE_APPLY_ACKNOWLEDGEMENT },
		{ QASE_GOVERNANCE_ACK: 'almost', QASE_GOVERNANCE_REFERENCE_ID: 'CHG-42' }
	]) {
		await assert.rejects(runGovernanceCommand({
			repository: fixture().repository,
			environment,
			args: ['runs-purge', '--apply']
		}), /requires|Apply requires/);
	}
	await assert.rejects(runGovernanceCommand({
		repository: fixture().repository,
		environment: {
			QASE_GOVERNANCE_ACK: GOVERNANCE_APPLY_ACKNOWLEDGEMENT,
			QASE_GOVERNANCE_REFERENCE_ID: 'CHG-42'
		},
		args: ['hold-place']
	}), /--apply/);
});

test('approved purge and auth cleanup pass only fixed repository acknowledgements', async () => {
	const environment = {
		QASE_GOVERNANCE_ACK: GOVERNANCE_APPLY_ACKNOWLEDGEMENT,
		QASE_GOVERNANCE_REFERENCE_ID: 'CHG-42',
		QASE_GOVERNANCE_REASON_CODE: 'retention_expired',
		QASE_GOVERNANCE_IDEMPOTENCY_KEY: 'purge/CHG-42/batch-001'
	};
	const target = fixture();
	await runGovernanceCommand({ repository: target.repository, environment, args: ['runs-purge', '--apply'] });
	await runGovernanceCommand({ repository: target.repository, environment, args: ['auth-cleanup', '--apply'] });
	assert.equal(target.calls[0].options.acknowledgement, PURGE_ACKNOWLEDGEMENT);
	assert.equal(target.calls[0].options.idempotencyKey, 'purge/CHG-42/batch-001');
	assert.equal(target.calls[1].options.acknowledgement, AUTH_CLEANUP_ACKNOWLEDGEMENT);
	assert.ok(target.calls.every(call => call.options.execute === true && call.options.actorType === 'worker'));
});

test('purge apply requires an operator idempotency key before repository execution', async () => {
	const target = fixture();
	await assert.rejects(runGovernanceCommand({
		repository: target.repository,
		environment: {
			QASE_GOVERNANCE_ACK: GOVERNANCE_APPLY_ACKNOWLEDGEMENT,
			QASE_GOVERNANCE_REFERENCE_ID: 'CHG-42'
		},
		args: ['runs-purge', '--apply']
	}), /QASE_GOVERNANCE_IDEMPOTENCY_KEY/);
	assert.equal(target.calls.length, 0);
});

test('hold commands are tenant-bound repository calls and never accept a tenant argument', async () => {
	const target = fixture();
	const environment = {
		QASE_GOVERNANCE_ACK: GOVERNANCE_APPLY_ACKNOWLEDGEMENT,
		QASE_GOVERNANCE_REFERENCE_ID: 'CASE-9',
		QASE_GOVERNANCE_RUN_ID: '6bf078e0-20df-48c3-a6f8-eb74ca14b9e1'
	};
	await runGovernanceCommand({ repository: target.repository, environment, args: ['hold-place', '--apply'] });
	await runGovernanceCommand({ repository: target.repository, environment, args: ['hold-release', '--apply'] });
	assert.deepEqual(target.calls.map(call => call.method), ['placeHold', 'releaseHold']);
	assert.ok(target.calls.every(call => call.options.runId === environment.QASE_GOVERNANCE_RUN_ID));
	assert.ok(target.calls.every(call => !Object.hasOwn(call.options, 'organizationId')));
});

test('cleanup attestation is explicit, reference-bound, and rejects ambiguous status metadata', async () => {
	const target = fixture();
	const environment = {
		QASE_GOVERNANCE_ACK: GOVERNANCE_APPLY_ACKNOWLEDGEMENT,
		QASE_GOVERNANCE_REFERENCE_ID: 'CHG-42',
		QASE_GOVERNANCE_RUN_ID: '6bf078e0-20df-48c3-a6f8-eb74ca14b9e1',
		QASE_GOVERNANCE_CLEANUP_STATUS: 'completed'
	};
	await runGovernanceCommand({
		repository: target.repository,
		cleanupRepository: target.repository,
		environment,
		args: ['cleanup-attest', '--apply']
	});
	assert.equal(target.calls.length, 1);
	assert.equal(target.calls[0].method, 'attestRunCleanup');
	assert.equal(target.calls[0].options.runId, environment.QASE_GOVERNANCE_RUN_ID);
	assert.equal(target.calls[0].options.execute, true);
	assert.equal(target.calls[0].options.acknowledgement, CLEANUP_ATTESTATION_ACKNOWLEDGEMENT);
	assert.equal(target.calls[0].options.actorType, 'worker');
	assert.equal(target.calls[0].options.referenceId, 'CHG-42');
	assert.equal(target.calls[0].options.policyVersion, 'qase-data-lifecycle/v1',
		'policy versions containing a slash remain valid opaque policy identifiers');

	for (const patch of [
		{ QASE_GOVERNANCE_CLEANUP_STATUS: '' },
		{ QASE_GOVERNANCE_CLEANUP_STATUS: 'failed', QASE_GOVERNANCE_CLEANUP_ERROR_CODE: '' },
		{ QASE_GOVERNANCE_CLEANUP_STATUS: 'completed', QASE_GOVERNANCE_CLEANUP_ERROR_CODE: 'should_not_exist' }
	]) {
		await assert.rejects(runGovernanceCommand({
			repository: target.repository,
			cleanupRepository: target.repository,
			environment: { ...environment, ...patch },
			args: ['cleanup-attest', '--apply']
		}), /status|requires|cannot include/i);
	}

	const failed = fixture();
	await runGovernanceCommand({
		repository: failed.repository,
		cleanupRepository: failed.repository,
		environment: {
			...environment,
			QASE_GOVERNANCE_CLEANUP_STATUS: 'failed',
			QASE_GOVERNANCE_CLEANUP_ERROR_CODE: 'worker_volume_unreachable'
		},
		args: ['cleanup-attest', '--apply']
	});
	assert.equal(failed.calls.length, 1);
	assert.equal(failed.calls[0].method, 'recordCleanup');
	assert.equal(failed.calls[0].runId, environment.QASE_GOVERNANCE_RUN_ID);
	assert.equal(failed.calls[0].options.status, 'failed');
	assert.equal(failed.calls[0].options.errorCode, 'worker_volume_unreachable');
	assert.equal(failed.calls[0].options.referenceId, 'CHG-42');
});

test('unknown actions fail before touching the repository', async () => {
	const target = fixture();
	await assert.rejects(runGovernanceCommand({ repository: target.repository, args: ['delete-everything'] }),
		/Unknown governance action/);
	assert.equal(target.calls.length, 0);
});
