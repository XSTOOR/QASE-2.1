import { randomBytes, randomUUID } from 'node:crypto';
import {
	DRYTIS_INBOUND_HEADERS,
	DRYTIS_INTEGRATION_SCHEMA_VERSION,
	signDrytisRequest
} from './protocol.js';

const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

export class DrytisQaseClientError extends Error {
	constructor(message, { code = 'qase_request_failed', status, retryable = false, correlationId, cause } = {}) {
		super(message, cause ? { cause } : undefined);
		this.name = 'DrytisQaseClientError';
		this.code = code;
		if (Number.isInteger(status)) this.status = status;
		this.retryable = retryable === true;
		if (correlationId) this.correlationId = correlationId;
	}
}

function exactOrigin(value) {
	let url;
	try { url = new URL(value); }
	catch { throw new TypeError('qaseOrigin must be one exact HTTPS origin.'); }
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
		|| url.pathname !== '/' || url.origin === 'null') {
		throw new TypeError('qaseOrigin must be one exact HTTPS origin.');
	}
	return url.origin;
}

function signingKey(value) {
	if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
		const result = Buffer.from(value);
		if (result.length === 32) return result;
	}
	if (typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)) {
		const result = Buffer.from(value, 'base64url');
		if (result.length === 32) return result;
	}
	throw new TypeError('signingKey must be exactly 32 bytes or its unpadded base64url encoding.');
}

function canonicalReviewId(value) {
	if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError('reviewId must be a canonical UUID.');
	return value;
}

function boundedToken(value, label, minimum = 8, maximum = 128) {
	if (typeof value !== 'string' || value.length < minimum || value.length > maximum
		|| !/^[A-Za-z0-9][A-Za-z0-9._~:/-]*$/.test(value)) {
		throw new TypeError(`${label} is invalid.`);
	}
	return value;
}

function boundedInteger(value, label, minimum, maximum) {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
	}
	return value;
}

function newToken(prefix, createUuid) {
	return `${prefix}-${createUuid()}`;
}

function responseJson(bytes, response) {
	if (bytes.length === 0) return undefined;
	let value;
	try { value = JSON.parse(bytes.toString('utf8')); }
	catch {
		throw new DrytisQaseClientError('Qase returned an invalid JSON response.', {
			code: 'invalid_qase_response', status: response.status, retryable: response.status >= 500
		});
	}
	return value;
}

async function readBoundedResponse(response, maximum) {
	const contentType = String(response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
	if (contentType !== 'application/json' && !contentType.endsWith('+json')) {
		throw new DrytisQaseClientError('Qase returned a non-JSON response.', {
			code: 'invalid_qase_response', status: response.status, retryable: response.status >= 500
		});
	}
	const declared = Number(response.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maximum) {
		throw new DrytisQaseClientError('Qase returned an oversized response.', {
			code: 'qase_response_too_large', status: response.status
		});
	}
	if (!response.body?.getReader) {
		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.length > maximum) throw new DrytisQaseClientError('Qase returned an oversized response.', {
			code: 'qase_response_too_large', status: response.status
		});
		return bytes;
	}
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maximum) {
				await reader.cancel().catch(() => {});
				throw new DrytisQaseClientError('Qase returned an oversized response.', {
					code: 'qase_response_too_large', status: response.status
				});
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, total);
}

function sleep(milliseconds, signal) {
	if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('The operation was aborted.'));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, milliseconds);
		if (signal) signal.addEventListener('abort', () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error('The operation was aborted.'));
		}, { once: true });
	});
}

/**
 * Build the revision-bound payload Drytis may hand to its coding agent. This
 * helper never applies a patch; Drytis still owns approval, branching, tests,
 * deployment, and verification against a fresh Qase run.
 */
export function buildDrytisRepairBundle(result) {
	if (!result || typeof result !== 'object' || !TERMINAL.has(result.status)) {
		throw new DrytisQaseClientError('A terminal Qase review result is required.', {
			code: 'review_not_terminal'
		});
	}
	const revision = result.project?.revision;
	if (typeof revision !== 'string' || !revision || revision.length > 200) {
		throw new DrytisQaseClientError('The Qase result is not bound to a project revision.', {
			code: 'invalid_repair_bundle'
		});
	}
	if (!Array.isArray(result.repairTasks) || result.repairTasks.length > 80) {
		throw new DrytisQaseClientError('The Qase repair-task collection is invalid.', {
			code: 'invalid_repair_bundle'
		});
	}
	const tasks = result.repairTasks.map((task, index) => {
		if (!task || typeof task !== 'object' || task.revision !== revision
			|| typeof task.id !== 'string' || typeof task.prompt !== 'string'
			|| task.prompt.length === 0 || task.prompt.length > 20_000) {
			throw new DrytisQaseClientError(`Qase repair task ${index} is not revision-bound.`, {
				code: 'invalid_repair_bundle'
			});
		}
		return Object.freeze({
			id: task.id,
			type: task.type,
			findingId: task.findingId,
			severity: task.severity,
			revision,
			...(typeof task.snapshotSha256 === 'string' ? { snapshotSha256: task.snapshotSha256 } : {}),
			...(typeof task.path === 'string' ? { path: task.path } : {}),
			...(Number.isInteger(task.startLine) ? { startLine: task.startLine } : {}),
			prompt: task.prompt
		});
	});
	const summary = result.summary && typeof result.summary === 'object'
		? Object.freeze(structuredClone(result.summary))
		: Object.freeze({});
	return Object.freeze({
		schemaVersion: result.schemaVersion,
		externalReviewId: result.externalReviewId,
		qaseRunId: result.qaseRunId,
		project: Object.freeze({ id: result.project.id, name: result.project.name, revision }),
		status: result.status,
		summary,
		tasks: Object.freeze(tasks),
		requiresHumanApproval: true,
		verification: 'Create a new Qase review for the repaired immutable revision.'
	});
}

/**
 * Server-side adapter for the Drytis backend. Never bundle this module or its
 * signing key into the Studio browser/toolbar.
 */
export function createDrytisQaseClient({
	qaseOrigin,
	signingKey: encodedSigningKey,
	fetchImpl = globalThis.fetch,
	now = Date.now,
	createUuid = randomUUID,
	createNonce = () => randomBytes(18).toString('base64url'),
	maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
	requestTimeoutMs = 10_000
} = {}) {
	const origin = exactOrigin(qaseOrigin);
	const key = signingKey(encodedSigningKey);
	if (typeof fetchImpl !== 'function' || typeof now !== 'function'
		|| typeof createUuid !== 'function' || typeof createNonce !== 'function') {
		throw new TypeError('Drytis Qase client dependencies are invalid.');
	}
	boundedInteger(maxResponseBytes, 'maxResponseBytes', 1_024, 5 * 1024 * 1024);
	boundedInteger(requestTimeoutMs, 'requestTimeoutMs', 250, 30_000);

	async function request(path, {
		method = 'GET', json, idempotencyKey, correlationId, signal
	} = {}) {
		const target = new URL(path, `${origin}/`);
		if (target.origin !== origin || !target.pathname.startsWith('/internal/v1/drytis/')) {
			throw new TypeError('The Qase integration request target is invalid.');
		}
		const requestTarget = `${target.pathname}${target.search}`;
		const normalizedMethod = String(method).toUpperCase();
		const body = json === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(json), 'utf8');
		if (body.length > MAX_REQUEST_BYTES) throw new TypeError('The Qase integration request exceeds 16 MiB.');
		const businessKey = boundedToken(idempotencyKey ?? newToken('qase', createUuid), 'idempotencyKey', 8, 200);
		const correlation = boundedToken(correlationId ?? newToken('corr', createUuid), 'correlationId');
		const timestamp = String(Math.floor(Number(now()) / 1000));
		if (!/^\d{10,11}$/.test(timestamp)) throw new TypeError('The client clock is invalid.');
		const nonce = boundedToken(createNonce(), 'nonce', 16, 128);
		const signature = signDrytisRequest({
			signingKey: key,
			signer: 'drytis',
			timestamp,
			nonce,
			idempotencyKey: businessKey,
			correlationId: correlation,
			method: normalizedMethod,
			requestTarget,
			body
		});
		let response;
		const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
		const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		try {
			response = await fetchImpl(target, {
				method: normalizedMethod,
				headers: {
					[DRYTIS_INBOUND_HEADERS.timestamp]: timestamp,
					[DRYTIS_INBOUND_HEADERS.nonce]: nonce,
					[DRYTIS_INBOUND_HEADERS.idempotencyKey]: businessKey,
					[DRYTIS_INBOUND_HEADERS.correlationId]: correlation,
					[DRYTIS_INBOUND_HEADERS.signature]: signature,
					Accept: 'application/json',
					...(json === undefined ? {} : { 'Content-Type': 'application/json' })
				},
				...(json === undefined ? {} : { body }),
				redirect: 'error',
				signal: requestSignal
			});
		} catch (cause) {
			throw new DrytisQaseClientError('Qase is temporarily unreachable.', {
				code: 'qase_unreachable', retryable: true, correlationId: correlation, cause
			});
		}
		let bytes;
		try { bytes = await readBoundedResponse(response, maxResponseBytes); }
		catch (error) {
			if (error instanceof DrytisQaseClientError && !error.correlationId) error.correlationId = correlation;
			throw error;
		}
		const payload = responseJson(bytes, response);
		if (!response.ok) {
			const error = payload?.error;
			throw new DrytisQaseClientError(
				typeof error?.message === 'string' ? error.message : 'Qase rejected the integration request.', {
					code: typeof error?.code === 'string' ? error.code : 'qase_request_rejected',
					status: response.status,
					retryable: error?.retryable === true || response.status >= 500,
					correlationId: error?.correlationId ?? response.headers.get('x-correlation-id') ?? correlation
				}
			);
		}
		return payload;
	}

	return Object.freeze({
		origin,
		schemaVersion: DRYTIS_INTEGRATION_SCHEMA_VERSION,
		capabilities(options) {
			return request('/internal/v1/drytis/capabilities', options);
		},
		createReview(review, options = {}) {
			return request('/internal/v1/drytis/reviews', { ...options, method: 'POST', json: review });
		},
		getReview(reviewId, options = {}) {
			return request(`/internal/v1/drytis/reviews/${canonicalReviewId(reviewId)}`, options);
		},
		startReview(reviewId, options = {}) {
			return request(`/internal/v1/drytis/reviews/${canonicalReviewId(reviewId)}/start`, {
				...options, method: 'POST', json: {}
			});
		},
		stopReview(reviewId, options = {}) {
			return request(`/internal/v1/drytis/reviews/${canonicalReviewId(reviewId)}/stop`, {
				...options, method: 'POST', json: {}
			});
		},
		deliverReview(reviewId, options = {}) {
			return request(`/internal/v1/drytis/reviews/${canonicalReviewId(reviewId)}/deliver`, {
				...options, method: 'POST', json: {}
			});
		},
		async waitForReview(reviewId, {
			signal,
			timeoutMs = 15 * 60_000,
			minimumDelayMs = 500,
			maximumDelayMs = 5_000,
			onUpdate
		} = {}) {
			boundedInteger(timeoutMs, 'timeoutMs', 1_000, 24 * 60 * 60_000);
			boundedInteger(minimumDelayMs, 'minimumDelayMs', 100, 60_000);
			boundedInteger(maximumDelayMs, 'maximumDelayMs', minimumDelayMs, 60_000);
			if (onUpdate !== undefined && typeof onUpdate !== 'function') throw new TypeError('onUpdate must be a function.');
			const started = Number(now());
			let delay = minimumDelayMs;
			while (Number(now()) - started <= timeoutMs) {
				const result = await request(`/internal/v1/drytis/reviews/${canonicalReviewId(reviewId)}`, { signal });
				await onUpdate?.(result);
				if (TERMINAL.has(result?.status) || result?.status === 'awaiting_input') return result;
				await sleep(delay, signal);
				delay = Math.min(maximumDelayMs, Math.ceil(delay * 1.7));
			}
			throw new DrytisQaseClientError('Timed out while waiting for the Qase review.', {
				code: 'qase_review_timeout', retryable: true
			});
		},
		launchDescriptor(result) {
			let launch;
			try { launch = new URL(result?.launchUrl, `${origin}/`); }
			catch { throw new DrytisQaseClientError('Qase returned an invalid launch URL.', { code: 'invalid_launch_url' }); }
			if (launch.origin !== origin || launch.protocol !== 'https:') {
				throw new DrytisQaseClientError('Qase returned an untrusted launch URL.', { code: 'invalid_launch_url' });
			}
			return Object.freeze({
				src: launch.toString(),
				title: 'QASE project quality workspace',
				sandbox: 'allow-forms allow-scripts allow-same-origin allow-popups-to-escape-sandbox',
				referrerPolicy: 'no-referrer',
				allow: ''
			});
		},
		buildRepairBundle: buildDrytisRepairBundle
	});
}
