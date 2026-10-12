/**
 * Matrix run service (2027.03.0, #14633 NI02 Phase 1).
 *
 * One shared workflow (test case) executed across many device/browser
 * profiles, server-orchestrated, with per-profile result records — replacing
 * the client-side loop (bulkRunView launchPairs → N × POST /api/sessions).
 *
 * Honesty contract (NI02 "Actual gaps" / NI03 "CRITICAL RESULT RULE"):
 * an item's status may only become PASSED or FAILED through an actual
 * execution outcome. Profiles that cannot or do not execute carry explicit
 * states — NOT_RUN (deselected), UNAVAILABLE / BLOCKED (runtime missing),
 * NOT_SUPPORTED (browser gate, e.g. DuckDuckGo), ERROR — never a derived pass.
 *
 * Follows the bugService pattern: local JSON backend + store-agnostic facade
 * in one module; the postgres repository lives in
 * postgres/matrixRunRepository.js and implements the same backend interface.
 */

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveBrowserSupport, BROWSER_SUPPORT_STATUS } from './browserSupportResolution.js';

/** Per-item status vocabulary — the honest set, persisted per item.
 * #15043 (B1): QUEUED = scheduled-for-execution (between PENDING and RUNNING);
 * CANCELLED = was queued but the run was cancelled before launch. */
export const MATRIX_ITEM_STATUSES = Object.freeze([
	'PENDING', 'QUEUED', 'RUNNING', 'PASSED', 'FAILED',
	'NOT_RUN', 'UNAVAILABLE', 'NOT_SUPPORTED', 'BLOCKED', 'ERROR', 'CANCELLED'
]);

export class MatrixValidationError extends Error {
	constructor(message) {
		super(message);
		this.name = 'MatrixValidationError';
		this.code = 'QASE_MATRIX_INVALID';
	}
}

// ---------------------------------------------------------------------------
// Default profile matrix (NI02 default execution)
// ---------------------------------------------------------------------------

/**
 * One representative environment per device category, per browser. The default
 * matrix covers: iPhone, Android phone, iPad, Android tablet, Windows, macOS —
 * the agreed NI01 categories — resolved against the LIVE catalog at request
 * time (never hardcoded envIds, so catalog updates flow through).
 */
export const DEFAULT_PROFILE_RULES = Object.freeze([
	{ id: 'iphone', platform: 'ios', device: 'iPhone 17 Pro', osVersion: '26.0' },
	{ id: 'android-phone', platform: 'android', device: 'Pixel 9', osVersion: '16' },
	{ id: 'ipad', platform: 'ipados', device: 'iPad Pro 13 (M4)', osVersion: '26.0' },
	{ id: 'android-tablet', platform: 'android', device: 'Galaxy Tab S9', osVersion: '15' },
	{ id: 'windows', platform: 'windows', device: 'Windows Laptop', osVersion: '11' },
	{ id: 'macos', platform: 'macos', device: 'MacBook Air (M3)', osVersion: 'Tahoe' }
]);

/**
 * Resolve the default matrix items from the live environment list.
 * @returns {Array<{ruleId, envId}>} one envId per category rule (rules whose
 * device/os no longer exist are skipped — never invented).
 */
export function resolveDefaultProfiles(listEnvironments) {
	const items = [];
	for (const rule of DEFAULT_PROFILE_RULES) {
		const match = listEnvironments.find((env) => env.platform === rule.platform
			&& env.device === rule.device
			&& String(env.osVersion) === String(rule.osVersion));
		if (match) items.push({ ruleId: rule.id, envId: match.envId });
	}
	return items;
}

// ---------------------------------------------------------------------------
// Item expansion: profile × selected browsers
// ---------------------------------------------------------------------------

/**
 * Expand requested profiles × selected browsers into item specs.
 *
 * Browsers absent from `selectedBrowsers` are recorded as NOT_RUN candidates
 * (reason "deselected by user") so they can never render as PASSED; browsers
 * resolving not_supported (DuckDuckGo) are recorded NOT_SUPPORTED with the
 * provider's reason. Only executable combinations launch.
 *
 * @param {Array} environments resolved environment records (with browserSupport)
 * @param {Array<{envId, browsers?: string[]}>} profileRequests per-profile request
 * @param {string[]} selectedBrowsers browser codes selected for this run
 */
export async function expandMatrixItems(environments, profileRequests, selectedBrowsers, { deselectedBrowsers = [] } = {}) {
	if (!Array.isArray(profileRequests) || profileRequests.length === 0) {
		throw new MatrixValidationError('At least one profile is required.');
	}
	if (!Array.isArray(selectedBrowsers) || selectedBrowsers.length === 0) {
		throw new MatrixValidationError('At least one browser must be selected.');
	}
	const selected = new Set(selectedBrowsers.map(String));
	// #14649: run-level deselections (submitted via `browsers` while the full
	// supported set travelled in `selectedBrowsers`) materialize as NOT_RUN
	// items so a deselection is recorded per matrix run, never invisible.
	const deselected = new Set(deselectedBrowsers.map(String));
	const byEnvId = new Map(environments.map((env) => [env.envId, env]));
	// All env records for the same (platform, device, osVersion) — the list is
	// one record per browser+version, so a profile's browser target must be
	// found among its siblings.
	const siblingsKey = (env) => `${env.platform}|${env.device}|${env.osVersion}`;
	const siblings = new Map();
	for (const env of environments) {
		const key = siblingsKey(env);
		if (!siblings.has(key)) siblings.set(key, []);
		siblings.get(key).push(env);
	}
	const items = [];
	const seen = new Set();
	for (const request of profileRequests) {
		const env = byEnvId.get(String(request.envId ?? ''));
		if (!env) {
			throw new MatrixValidationError(`Unknown environment "${request.envId}".`);
		}
		const family = siblings.get(siblingsKey(env)) ?? [env];
		// Per-profile browser override, else the run-wide selection ∪ explicit
		// run-level deselections (kept as NOT_RUN items).
		const overrideBrowsers = Array.isArray(request.browsers) && request.browsers.length > 0
			? request.browsers.map(String)
			: null;
		const browsers = overrideBrowsers
			?? [...new Set([...selected, ...deselected])];
		for (const code of browsers) {
			const support = await resolveBrowserSupport(env.platform, code, {});
			// Newest version first (env list may be unsorted).
			const targets = family
				.filter((candidate) => candidate.browserCode === code)
				.sort((a, b) => Number(b.browserVersion) - Number(a.browserVersion));
			if (!targets.length) {
				// Browser not offered on this platform (inventory-level gap, e.g.
				// Safari on Windows): NOT_SUPPORTED with an inventory reason.
				items.push({ env, browserCode: code, status: 'NOT_SUPPORTED', reason: `${code} is not available on ${env.platform}.` });
				continue;
			}
			const target = targets[0];
			const key = `${env.envId}|${code}`;
			if (seen.has(key)) continue;
			seen.add(key);
			if (support.status === BROWSER_SUPPORT_STATUS.NOT_SUPPORTED) {
				items.push({ env: target, browserCode: code, browserVersion: target.browserVersion, status: 'NOT_SUPPORTED', reason: support.reason, browserSupport: support });
				continue;
			}
			if (!selected.has(code) || deselected.has(code)) {
				items.push({ env: target, browserCode: code, browserVersion: target.browserVersion, status: 'NOT_RUN', reason: 'Deselected by user.', browserSupport: support });
				continue;
			}
			items.push({ env: target, browserCode: code, browserVersion: target.browserVersion, status: 'PENDING', reason: null, browserSupport: support, envTarget: target });
		}
	}
	return items;
}

// RT1 (#14680): envBrowserstackFlag removed — no external provider
// participates in browser executability; the registry-driven resolver owns
// the truth. Kept as a no-op for any internal callers during transition.
function envBrowserstackFlag() {
	return {};
}

// ---------------------------------------------------------------------------
// Local JSON backend (mirrors bugService's createLocalBugBackend)
// ---------------------------------------------------------------------------

export function createLocalMatrixBackend(options = {}) {
	const stateDir = options.stateDir ?? path.join(process.cwd(), '.qase');
	const stateFile = options.stateFile ?? path.join(stateDir, 'matrix-runs.json');
	/** @type {Map<string, object>} */
	const byId = new Map();
	let loaded = false;

	function loadFromDisk() {
		if (loaded) return;
		loaded = true;
		try {
			const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
			for (const run of Array.isArray(parsed) ? parsed : []) {
				if (run?.id) byId.set(run.id, run);
			}
		} catch {
			/* first boot */
		}
	}

	/**
	 * Persist the full run map to disk — debounced + off the event loop.
	 * updateItem fires ~8x per item; on a 36MB store a synchronous write per
	 * update starved the entire server (see .drytis/memory/fix-matrix-persist-starvation.md).
	 * Run creation/termination always persists immediately; item-level churn is
	 * coalesced. Worst-case loss window on a crash is a few seconds of item status.
	 */
	let persistTimer = null;
	let persistInFlight = false;

	function schedulePersist() {
		if (persistTimer) return;
		persistTimer = setTimeout(() => {
			persistTimer = null;
			void persistDebounced();
		}, 500);
		persistTimer.unref?.();
	}

	async function persistDebounced() {
		if (persistInFlight) {
			schedulePersist(); // a write landed while one was in flight — go again
			return;
		}
		persistInFlight = true;
		try {
			await persistAsync();
		} catch {
			/* a dashboard that cannot write its state file is still usable */
		} finally {
			persistInFlight = false;
		}
	}

	async function persistAsync() {
		await fsPromises.mkdir(stateDir, { recursive: true });
		const tmp = `${stateFile}.tmp-${process.pid}-${randomUUID()}`;
		await fsPromises.writeFile(tmp, JSON.stringify([...byId.values()], undefined, '\t'), { mode: 0o600 });
		await fsPromises.rename(tmp, stateFile);
	}

	function persistNow() {
		// Synchronous, only for low-frequency, must-not-lose events (create, terminal).
		try {
			fs.mkdirSync(stateDir, { recursive: true });
			const tmp = `${stateFile}.tmp-${process.pid}-${randomUUID()}`;
			fs.writeFileSync(tmp, JSON.stringify([...byId.values()], undefined, '\t'), { mode: 0o600 });
			fs.renameSync(tmp, stateFile);
		} catch {
			/* a dashboard that cannot write its state file is still usable */
		}
	}

	return {
		async list(tenant) {
			loadFromDisk();
			return [...byId.values()]
				.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
		},
		async get(tenant, id) {
			loadFromDisk();
			return byId.get(id) ?? null;
		},
		async create(tenant, record) {
			loadFromDisk();
			byId.set(record.id, structuredClone(record));
			persistNow();
			return structuredClone(record);
		},
		async update(tenant, id, patch) {
			loadFromDisk();
			const existing = byId.get(id);
			if (!existing) return null;
			const next = { ...existing, ...patch, updatedAt: new Date().toISOString() };
			byId.set(id, next);
			persistNow();
			return structuredClone(next);
		},
		async updateItem(tenant, matrixRunId, itemId, patch) {
			loadFromDisk();
			const run = byId.get(matrixRunId);
			if (!run) return null;
			const index = run.items.findIndex((item) => item.id === itemId);
			if (index === -1) return null;
			run.items[index] = { ...run.items[index], ...patch, updatedAt: new Date().toISOString() };
			schedulePersist();
			return structuredClone(run.items[index]);
		}
	};
}

// ---------------------------------------------------------------------------
// Store-agnostic facade
// ---------------------------------------------------------------------------

/**
 * @param {object} backend list/get/create/update/updateItem (local JSON or postgres)
 * @param {object} services { environments, runs, testCases }
 */
export function createMatrixService(backend, { environments, runs, testCases } = {}) {
	function requireServices() {
		if (!environments || !runs || !testCases) {
			throw new MatrixValidationError('Matrix runs require environment, run, and test-case services.');
		}
	}

	/**
	 * Create a matrix run and its items. Validates the workflow + every profile
	 * against the live services exactly as POST /api/sessions does, then stores
	 * honest per-item states. Execution is started separately (start).
	 */
	async function create(input, { defaultsUsed = false, ownerUserId = null } = {}) {
		requireServices();
		const testCaseId = String(input?.testCaseId ?? '').trim();
		// #15043 (B1): QA-start runs carry no test case — the shared workflow
		// is the QA kickoff text itself (targetUrl + coverage message), which
		// travels on the run record; the item execution path reads it there.
		const targetUrl = String(input?.targetUrl ?? '').trim();
		if (!testCaseId && !targetUrl) throw new MatrixValidationError('testCaseId or targetUrl is required.');
		if (!/^https?:\/\//i.test(targetUrl)) throw new MatrixValidationError('targetUrl must be an http(s) URL.');
		const list = await environments.list({ limit: 80000 });
		// Phase 3 (#14937): the QA launcher sends EXACT configurations — the
		// device–OS–browser–version envIds the user kept selected. Every
		// selected configuration becomes an item; unknown/unavailable ids are
		// recorded honestly (BLOCKED), never silently dropped, so "every
		// selected configuration gets a result" holds even when the catalog
		// changed between selection and submit.
		const configurationEnvIds = Array.isArray(input?.configurationEnvIds)
			? input.configurationEnvIds.map(String).filter(Boolean)
			: null;
		if (configurationEnvIds !== null && configurationEnvIds.length === 0) {
			throw new MatrixValidationError('At least one configuration must be selected.');
		}
		const selectedBrowsers = configurationEnvIds
			? [...new Set(configurationEnvIds.map((envId) => {
				const env = list.find((candidate) => candidate.envId === envId);
				return env?.browserCode;
			}).filter(Boolean))]
			: (input?.selectedBrowsers ?? ['chrome', 'edge', 'firefox', 'safari', 'opera', 'brave', 'duckduckgo'])
				.map(String);
		// #14649: run-level deselection — `browsers` names the subset the user
		// kept; browsers present in selectedBrowsers but absent from it are
		// recorded per item as NOT_RUN ("Deselected by user."), never dropped.
		const deselectedBrowsers = Array.isArray(input?.browsers)
			? selectedBrowsers.filter((code) => !input.browsers.map(String).includes(code))
			: [];
		let profileRequests = Array.isArray(input?.profiles) ? input.profiles : null;
		let defaultsSnapshot = null;
		if (!profileRequests && configurationEnvIds) {
			profileRequests = [...new Set(configurationEnvIds)].map((envId) => ({ envId }));
		} else if (!profileRequests) {
			profileRequests = resolveDefaultProfiles(list).map((entry) => ({ envId: entry.envId }));
			defaultsSnapshot = { rules: DEFAULT_PROFILE_RULES, resolved: profileRequests };
			defaultsUsed = true;
		}
		// Workflow is shared, not duplicated: ONE test case reference frozen per run.
		// Note: environment membership is NOT enforced per item here — the matrix
		// intentionally crosses profiles beyond a case's assigned environments
		// (the assignment UI remains for single runs).
		// #15043 (B1): QA-start runs (no testCaseId) skip the case lookup —
		// the workflow is the kickoff text travelling on the run record.
		const testCase = testCaseId
			? await testCases.resolveForRun(testCaseId, null)
			: { caseNumber: null, title: 'QA run' };
		let items;
		if (configurationEnvIds) {
			// Launcher mode: pin each item to the EXACT requested configuration.
			// The profile×browser expansion is skipped — every requested envId
			// becomes exactly one item, honestly BLOCKED when it vanished from
			// the catalog (so "every selected configuration gets a result" holds
			// even if the catalog changed between selection and submit).
			const byEnvId = new Map(list.map((env) => [env.envId, env]));
			const seen = new Set();
			const pinned = [];
			for (const envId of configurationEnvIds) {
				if (seen.has(envId)) continue;
				seen.add(envId);
				const env = byEnvId.get(envId);
				if (!env) {
					// Unknown configurationEnvId is a mapping/configuration bug
					// (frontend synthetic ID, stale catalog, provider drift) —
					// log it loudly for diagnosis; the item still gets an
					// honest BLOCKED record below, never a silent drop (#14276).
					console.warn(`[matrix] configuration mapping bug: launcher sent configurationEnvId "${envId}" which does not resolve to a catalog environment`);
					pinned.push({
						env: { envId, platform: 'unknown', device: 'Unknown configuration', os: 'unknown', osVersion: 'unknown', browserVersion: null },
						browserCode: 'unknown',
						browserVersion: null,
						status: 'BLOCKED',
						reason: `Configuration "${envId}" is no longer in the catalog.`
					});
					continue;
				}
				const support = await resolveBrowserSupport(env.platform, env.browserCode, {});
				pinned.push(support.status === BROWSER_SUPPORT_STATUS.NOT_SUPPORTED
					? { env, browserCode: env.browserCode, browserVersion: env.browserVersion, status: 'NOT_SUPPORTED', reason: support.reason, browserSupport: support }
					: { env, browserCode: env.browserCode, browserVersion: env.browserVersion, status: 'PENDING', reason: null, browserSupport: support, envTarget: env });
			}
			items = pinned;
		} else {
			items = await expandMatrixItems(list, profileRequests, selectedBrowsers, { deselectedBrowsers });
		}
		items = items.map((spec, ordinal) => ({
			id: randomUUID(),
			ordinal,
			testCaseId,
			environmentId: spec.env.envId,
			profileId: spec.env.profileId,
			platform: spec.env.platform,
			device: spec.env.device,
			os: spec.env.os,
			osVersion: spec.env.osVersion,
			browser: spec.browserCode,
			browserCode: spec.browserCode,
			browserVersion: spec.browserVersion ?? spec.env.browserVersion,
			deviceType: spec.env.deviceType ?? null,
			status: spec.status,
			reason: spec.reason ?? null,
			// #14633: browser capability snapshot travels with the item so the
			// orchestrator can re-gate at execution time (credentials may have
			// changed since creation — re-resolved there; this is the frozen
			// creation-time verdict for auditability).
			browserSupport: spec.browserSupport ?? null,
			// Bounded retry ledger (#14937): persisted per item, survives
			// orchestrator restarts; 0 until a retry is actually taken.
			retryCount: 0,
			sessionId: null,
			verdict: null,
			error: null,
			findings: [],
			startedAt: null,
			finishedAt: null,
			durationMs: null,
			// #14650 (NI02 Phase 2): per-profile evidence — filled at
			// execution; stays null/[] until a real session produced them.
			executionLevel: null,
			executionProvider: null,
			artifactRefs: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString()
		}));
		const record = {
			id: `matrix-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
			title: String(input?.title ?? `Matrix — ${testCase.title ?? testCaseId}`),
			targetUrl,
			// #15043 (B1): QA-start context — the kickoff workflow for items to
			// execute when no test case drives the run.
			kickoffText: input?.kickoffText ?? null,
			selectedTests: input?.selectedTests ?? null,
			securityAuthorization: input?.securityAuthorization ?? null,
			scopeSelection: input?.scopeSelection ?? null,
			status: 'pending',
			defaultsUsed,
			defaultsSnapshot,
			requestedProfiles: profileRequests,
			requestedBrowsers: selectedBrowsers,
			itemCount: items.length,
			items,
			ownerUserId: input?.ownerUserId ?? ownerUserId ?? null,
			createdAt: new Date().toISOString(),
			startedAt: null,
			finishedAt: null,
			updatedAt: new Date().toISOString()
		};
		return backend.create(null, record);
	}

	// -----------------------------------------------------------------------
	// Pipeline Phase 2: parent runs + idempotent batches
	// -----------------------------------------------------------------------

	/**
	 * Create a PARENT run — a lightweight logical aggregate for a >2,000
	 * selection. Holds no items; batches reference it via parentId and the
	 * parent view is computed on read (get). totalPlanned is the true
	 * selection size at submission time (audit); coverage is derived from the
	 * batches that actually exist.
	 */
	async function createParentRun(input, { ownerUserId = null } = {}) {
		const targetUrl = String(input?.targetUrl ?? '').trim();
		if (!/^https?:\/\//i.test(targetUrl)) throw new MatrixValidationError('targetUrl must be an http(s) URL.');
		const record = {
			id: `matrix-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
			kind: 'parent',
			title: String(input?.title ?? `QA run — ${targetUrl}`).slice(0, 120),
			targetUrl,
			kickoffText: input?.kickoffText ?? null,
			selectedTests: input?.selectedTests ?? null,
			securityAuthorization: input?.securityAuthorization ?? null,
			scopeSelection: input?.scopeSelection ?? null,
			status: 'pending',
			totalPlanned: Number(input?.totalPlanned ?? 0) || 0,
			batchIds: [],
			itemCount: 0,
			items: [],
			ownerUserId: input?.ownerUserId ?? ownerUserId ?? null,
			createdAt: new Date().toISOString(),
			startedAt: null,
			finishedAt: null,
			updatedAt: new Date().toISOString()
		};
		return backend.create(null, record);
	}

	/**
	 * Create (or return the existing) BATCH under a parent. IDEMPOTENT on
	 * (parentId, batchKey): the same batch re-posted after a network failure
	 * returns the original batch — a retry can never duplicate items. Each
	 * batch is an ordinary runnable run (kind 'batch'); the existing create()
	 * path is reused for item materialization so every launcher-mode honesty
	 * rule (unknown envId → BLOCKED, DDG → NOT_SUPPORTED) applies identically.
	 */
	async function createBatch(input, { ownerUserId = null } = {}) {
		const parentId = String(input?.parentId ?? '').trim();
		const batchKey = String(input?.batchKey ?? '').trim();
		if (!parentId) throw new MatrixValidationError('parentId is required for a batch.');
		if (!batchKey) throw new MatrixValidationError('batchKey is required for a batch.');
		const parent = await backend.get(null, parentId);
		if (!parent) throw new MatrixValidationError(`Unknown parent run "${parentId}".`);
		if (parent.kind !== 'parent') throw new MatrixValidationError('parentId must reference a parent run.');
		const batchIndex = Number(input?.batchIndex ?? parent.batchIds.length) || 0;
		// Idempotency: an existing batch with the same key is returned as-is.
		const existing = parent.batchIds.length > 0
			? (await Promise.all(parent.batchIds.map((id) => backend.get(null, id))))
				.find((candidate) => candidate && candidate.batchKey === batchKey)
			: null;
		if (existing) return { run: existing, created: false };
		// Reuse create() for the runnable batch (validation + honest items),
		// then stamp batch metadata and link it to the parent.
		const batch = await create({ ...input, title: input?.title ?? `${parent.title} — batch ${batchIndex + 1}` },
			{ ownerUserId: ownerUserId ?? parent.ownerUserId ?? null });
		const stamped = await backend.update(null, batch.id, {
			kind: 'batch',
			parentId,
			batchKey,
			batchIndex
		});
		await backend.update(null, parentId, {
			batchIds: [...parent.batchIds, batch.id],
			status: parent.status === 'pending' ? 'pending' : parent.status,
			updatedAt: new Date().toISOString()
		});
		return { run: stamped, created: true };
	}

	/**
	 * Honest-state guard: PASSED/FAILED may only be written when the item has
	 * a completed execution outcome (a linked session with a verdict). Every
	 * other transition is checked against the frozen vocabulary.
	 */
	async function updateItem(matrixRunId, itemId, patch) {
		loadStatusVocabulary();
		const run = await backend.get(null, matrixRunId);
		if (!run) throw new MatrixValidationError(`Unknown matrix run "${matrixRunId}".`);
		const item = run.items.find((candidate) => candidate.id === itemId);
		if (!item) throw new MatrixValidationError(`Unknown matrix item "${itemId}".`);
		if (patch?.status !== undefined) {
			const status = String(patch.status);
			if (!MATRIX_ITEM_STATUSES.includes(status)) {
				throw new MatrixValidationError(`Invalid item status "${status}".`);
			}
			if ((status === 'PASSED' || status === 'FAILED')) {
				if (!patch.sessionId && !item.sessionId) {
					throw new MatrixValidationError('PASSED/FAILED requires a completed execution (sessionId) — never fabricate outcomes.');
				}
			}
		}
		return backend.updateItem(null, matrixRunId, itemId, patch);
	}

	function loadStatusVocabulary() { /* vocabulary frozen at module scope */ }

	return {
		create,
		createParentRun,
		createBatch,
		updateItem,
		get: async (id) => {
			const run = await backend.get(null, id);
			// Pipeline Phase 2: a PARENT run reads as the aggregated union of
			// its batches (computed on read — no stored aggregates to drift).
			// A batch or a legacy run (kind undefined) reads unchanged.
			if (run?.kind === 'parent' && Array.isArray(run.batchIds)) {
				const batches = [];
				for (const batchId of run.batchIds) {
					const batch = await backend.get(null, batchId);
					if (batch) batches.push(batch);
				}
				batches.sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0));
				const items = [];
				for (const batch of batches) items.push(...(batch.items ?? []));
				return {
					...run,
					items,
					itemCount: items.length,
					batchCount: batches.length,
					status: batches.every((batch) => ['done', 'cancelled', 'error', 'interrupted'].includes(batch.status))
						? (batches.every((batch) => batch.status === 'done') ? 'done' : 'interrupted')
						: (batches.some((batch) => batch.status === 'running') ? 'running' : run.status),
					startedAt: batches.map((batch) => batch.startedAt).filter(Boolean).sort()[0] ?? run.startedAt,
					finishedAt: batches.map((batch) => batch.finishedAt).filter(Boolean).sort().pop() ?? run.finishedAt,
					batches: batches.map(({ items: _items, ...summary }) => summary)
				};
			}
			return run;
		},
		list: () => backend.list(null),
		/** Orchestrator-internal: set run status + timing fields. */
		async _setStatus(id, status, timing = {}) {
			if (!['pending', 'running', 'done', 'error', 'interrupted', 'cancelled'].includes(status)) {
				throw new MatrixValidationError(`Invalid matrix run status "${status}".`);
			}
			return backend.update(null, id, { status, ...timing });
		},
		/**
		 * #15043 (B1): cancel a run — every QUEUED item becomes CANCELLED
		 * (never launched, never PASSED). RUNNING items finish their current
		 * turn and keep their honest outcome. Idempotent.
		 */
		async cancel(id, { reason = 'Cancelled by user.' } = {}) {
			const run = await backend.get(null, id);
			if (!run) throw new MatrixValidationError(`Unknown matrix run "${id}".`);
			let cancelled = 0;
			for (const item of run.items ?? []) {
				if (item.status === 'QUEUED' || item.status === 'PENDING') {
					await backend.updateItem(null, id, item.id, {
						status: 'CANCELLED',
						reason,
						finishedAt: new Date().toISOString()
					});
					cancelled += 1;
				}
			}
			const updated = await backend.update(null, id, {
				status: 'cancelled',
				cancelReason: reason,
				finishedAt: new Date().toISOString()
			});
			return { run: updated, cancelled };
		},
		backend
	};
}
