import {
	AUTH_CLEANUP_ACKNOWLEDGEMENT,
	CLEANUP_ATTESTATION_ACKNOWLEDGEMENT,
	PURGE_ACKNOWLEDGEMENT
} from './postgres/retentionRepository.js';

export const GOVERNANCE_APPLY_ACKNOWLEDGEMENT = 'I_APPROVE_QASE_DATA_LIFECYCLE';

const ACTIONS = new Set([
	'runs-preview', 'runs-purge', 'auth-preview', 'auth-cleanup',
	'hold-place', 'hold-release', 'cleanup-attest'
]);

function optionalNumber(environment, key) {
	const value = String(environment[key] ?? '').trim();
	return value ? Number(value) : undefined;
}

function mutationOptions(environment) {
	return {
		actorType: 'worker',
		reasonCode: String(environment.QASE_GOVERNANCE_REASON_CODE ?? 'operator_request').trim(),
		referenceId: String(environment.QASE_GOVERNANCE_REFERENCE_ID ?? '').trim() || undefined,
		correlationId: String(environment.QASE_GOVERNANCE_CORRELATION_ID ?? '').trim() || undefined,
		policyVersion: String(environment.QASE_GOVERNANCE_POLICY_VERSION ?? 'qase-data-lifecycle/v1').trim()
	};
}

function selectedPolicyVersion(environment) {
	return String(environment.QASE_GOVERNANCE_POLICY_VERSION ?? 'qase-data-lifecycle/v1').trim();
}

function requiredPurgeIdempotencyKey(environment) {
	const value = String(environment.QASE_GOVERNANCE_IDEMPOTENCY_KEY ?? '').trim();
	if (!value) {
		throw new TypeError('runs-purge requires a bounded QASE_GOVERNANCE_IDEMPOTENCY_KEY.');
	}
	return value;
}

function requireApply(environment, apply) {
	if (!apply) throw new TypeError('This governance action requires the --apply flag.');
	if (environment.QASE_GOVERNANCE_ACK !== GOVERNANCE_APPLY_ACKNOWLEDGEMENT) {
		throw new TypeError(`Apply requires QASE_GOVERNANCE_ACK=${GOVERNANCE_APPLY_ACKNOWLEDGEMENT}.`);
	}
	if (!String(environment.QASE_GOVERNANCE_REFERENCE_ID ?? '').trim()) {
		throw new TypeError('Apply requires a bounded QASE_GOVERNANCE_REFERENCE_ID change or case reference.');
	}
}

/** Dispatch one constructor-bound tenant governance command. */
export async function runGovernanceCommand({
	repository,
	cleanupRepository = repository,
	environment = {},
	args = []
} = {}) {
	if (!repository || typeof repository !== 'object') throw new TypeError('A retention repository is required.');
	const action = String(args[0] ?? '').trim();
	if (!ACTIONS.has(action)) {
		throw new TypeError(`Unknown governance action ${action || '(missing)'}.`);
	}
	const apply = args.includes('--apply');
	if (action.endsWith('-preview') && apply) {
		throw new TypeError('Preview actions do not accept --apply.');
	}
	const batchSize = optionalNumber(environment, 'QASE_GOVERNANCE_BATCH_SIZE');
	const retentionDays = optionalNumber(environment, 'QASE_GOVERNANCE_RETENTION_DAYS');

	switch (action) {
		case 'runs-preview':
			return repository.previewRuns({
				batchSize, retentionDays, policyVersion: selectedPolicyVersion(environment)
			});
		case 'auth-preview':
			return repository.cleanupExpiredAuth({ batchSize });
		case 'runs-purge':
			requireApply(environment, apply);
			return repository.purgeBatch({
				...mutationOptions(environment), batchSize, retentionDays,
				idempotencyKey: requiredPurgeIdempotencyKey(environment),
				execute: true, acknowledgement: PURGE_ACKNOWLEDGEMENT
			});
		case 'auth-cleanup':
			requireApply(environment, apply);
			return repository.cleanupExpiredAuth({
				...mutationOptions(environment), batchSize,
				execute: true, acknowledgement: AUTH_CLEANUP_ACKNOWLEDGEMENT
			});
		case 'hold-place':
			requireApply(environment, apply);
			return repository.placeHold({
				...mutationOptions(environment),
				runId: environment.QASE_GOVERNANCE_RUN_ID
			});
		case 'hold-release':
			requireApply(environment, apply);
			return repository.releaseHold({
				...mutationOptions(environment),
				runId: environment.QASE_GOVERNANCE_RUN_ID
			});
		case 'cleanup-attest': {
			requireApply(environment, apply);
			const status = String(environment.QASE_GOVERNANCE_CLEANUP_STATUS ?? '').trim();
			if (!['completed', 'failed'].includes(status)) {
				throw new TypeError('QASE_GOVERNANCE_CLEANUP_STATUS must be completed or failed.');
			}
			const errorCode = String(environment.QASE_GOVERNANCE_CLEANUP_ERROR_CODE ?? '').trim();
			if (status === 'failed' && !errorCode) {
				throw new TypeError('Failed cleanup attestation requires QASE_GOVERNANCE_CLEANUP_ERROR_CODE.');
			}
			if (status === 'completed' && errorCode) {
				throw new TypeError('Completed cleanup attestation cannot include a cleanup error code.');
			}
			const runId = environment.QASE_GOVERNANCE_RUN_ID;
			const options = {
				...mutationOptions(environment),
				status,
				...(errorCode ? { errorCode } : {})
			};
			if (status === 'completed') {
				if (typeof repository.attestRunCleanup !== 'function') {
					throw new TypeError('Completed cleanup attestation requires the retention repository.');
				}
				return repository.attestRunCleanup({
					...mutationOptions(environment),
					runId,
					execute: true,
					acknowledgement: CLEANUP_ATTESTATION_ACKNOWLEDGEMENT
				});
			}
			if (!cleanupRepository || typeof cleanupRepository.recordCleanup !== 'function') {
				throw new TypeError('Failed cleanup recording requires a lifecycle cleanup repository.');
			}
			return cleanupRepository.recordCleanup(runId, options);
		}
		default:
			throw new TypeError('Unsupported governance action.');
	}
}
