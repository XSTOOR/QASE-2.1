/**
 * Test cases with multi-environment assignment (Phase 4).
 *
 * A test case is a reusable QA scenario (title, steps, expected result, tags)
 * assigned to one or more testing environments. Runs reference a case via
 * testCaseId; the case + environment pair identifies an execution.
 *
 * Two persistence backends behind one service facade (mirrors environmentService):
 * local JSON file (.qase/test-cases.json) and PostgreSQL (migration 017).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export class TestCaseValidationError extends Error {
	constructor(message) {
		super(message);
		this.name = 'TestCaseValidationError';
		this.code = 'QASE_TESTCASE_INVALID';
	}
}

export class TestCaseConflictError extends Error {
	constructor(caseNumber) {
		super(`Test case ${caseNumber} already exists.`);
		this.name = 'TestCaseConflictError';
		this.code = 'QASE_TESTCASE_CONFLICT';
		this.caseNumber = caseNumber;
	}
}

const TITLE_MAX = 300;
const DESCRIPTION_MAX = 4000;
const EXPECTED_MAX = 4000;
const MAX_STEPS = 50;
const STEP_MAX = 1000;
const MAX_ENVIRONMENTS = 200;
const MAX_TAGS = 12;

/** Normalize + validate a create/update payload. Returns the case record fields. */
export function normalizeTestCaseInput(input = {}) {
	const title = typeof input.title === 'string' ? input.title.trim() : '';
	if (!title) throw new TestCaseValidationError('title is required.');
	if (title.length > TITLE_MAX) throw new TestCaseValidationError(`title must be at most ${TITLE_MAX} characters.`);
	const description = input.description === undefined || input.description === null
		? null
		: String(input.description).trim() || null;
	if (description && description.length > DESCRIPTION_MAX) {
		throw new TestCaseValidationError(`description must be at most ${DESCRIPTION_MAX} characters.`);
	}
	const expected = input.expected === undefined || input.expected === null
		? null
		: String(input.expected).trim() || null;
	if (expected && expected.length > EXPECTED_MAX) {
		throw new TestCaseValidationError(`expected must be at most ${EXPECTED_MAX} characters.`);
	}
	const steps = Array.isArray(input.steps) ? input.steps.map((step) => String(step).trim()).filter(Boolean) : [];
	if (steps.length > MAX_STEPS) throw new TestCaseValidationError(`steps is limited to ${MAX_STEPS} entries.`);
	if (steps.some((step) => step.length > STEP_MAX)) {
		throw new TestCaseValidationError(`each step must be at most ${STEP_MAX} characters.`);
	}
	const tags = Array.isArray(input.tags)
		? [...new Set(input.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))]
		: [];
	if (tags.length > MAX_TAGS) throw new TestCaseValidationError(`tags is limited to ${MAX_TAGS} entries.`);
	const environmentIds = Array.isArray(input.environmentIds)
		? [...new Set(input.environmentIds.map((id) => String(id).trim()))].filter(Boolean)
		: [];
	if (environmentIds.length > MAX_ENVIRONMENTS) {
		throw new TestCaseValidationError(`environmentIds is limited to ${MAX_ENVIRONMENTS} entries.`);
	}
	return {
		title,
		description,
		expected,
		steps,
		tags,
		environmentIds,
		// Provenance: 'manual' (default) vs 'auto' (agent-generated from a run).
		// The public API can only create manual records; the autogen engine sets
		// these through testCases.create with source passed explicitly.
		source: input.source === 'auto' ? 'auto' : 'manual',
		sourceRunId: typeof input.sourceRunId === 'string' ? input.sourceRunId.slice(0, 128) : null,
		sourceUrl: typeof input.sourceUrl === 'string' ? input.sourceUrl.slice(0, 2048) : null
	};
}

function nextCaseNumber(records) {
	let max = 0;
	for (const record of records.values()) {
		const match = /^TC-(\d+)$/.exec(record.caseNumber ?? '');
		if (match) max = Math.max(max, Number(match[1]));
	}
	return `TC-${String(max + 1).padStart(4, '0')}`;
}

function rowToTestCase(row) {
	if (!row) return null;
	return {
		id: row.id,
		caseNumber: row.case_number ?? row.caseNumber,
		title: row.title,
		description: row.description ?? null,
		steps: row.steps ?? [],
		expected: row.expected ?? null,
		tags: row.tags ?? [],
		environmentIds: row.environment_ids ?? row.environmentIds ?? [],
		source: row.source ?? 'manual',
		sourceRunId: row.source_run_id ?? row.sourceRunId ?? null,
		sourceUrl: row.source_url ?? row.sourceUrl ?? null,
		deleted: Boolean(row.deleted),
		createdAt: row.created_at ?? row.createdAt ?? null,
		updatedAt: row.updated_at ?? row.updatedAt ?? null
	};
}

/** Validate that every envId exists and is active; throws with the first problem. */
async function assertEnvironmentsAssignable(environmentsService, envIds, { allowMissing = [] } = {}) {
	if (!environmentsService || envIds.length === 0) return;
	const unknown = [];
	const inactive = [];
	for (const envId of envIds) {
		if (allowMissing.includes(envId)) continue;
		const env = await environmentsService.get(envId);
		if (!env) unknown.push(envId);
		else if (env.active === false) inactive.push(envId);
	}
	if (unknown.length) throw new TestCaseValidationError(`Unknown environment(s): ${unknown.join(', ')}.`);
	if (inactive.length) throw new TestCaseValidationError(`Inactive environment(s) cannot be assigned: ${inactive.join(', ')}.`);
}

// ---------------------------------------------------------------------------
// Local JSON backend
// ---------------------------------------------------------------------------

export function createLocalTestCaseBackend(options = {}) {
	const stateDir = options.stateDir ?? path.join(process.cwd(), '.qase');
	const stateFile = options.stateFile ?? path.join(stateDir, 'test-cases.json');
	/** @type {Map<string, any>} */
	const byCaseNumber = new Map();
	let loaded = false;

	function loadFromDisk() {
		if (loaded) return;
		loaded = true;
		try {
			const raw = fs.readFileSync(stateFile, 'utf8');
			const parsed = JSON.parse(raw);
			for (const record of Array.isArray(parsed) ? parsed : []) {
				if (record?.caseNumber) byCaseNumber.set(record.caseNumber, record);
			}
		} catch {
			/* first boot — empty file */
		}
	}

	function persistNow() {
		try {
			fs.mkdirSync(stateDir, { recursive: true });
			const tmp = `${stateFile}.tmp-${process.pid}-${randomUUID()}`;
			fs.writeFileSync(tmp, JSON.stringify([...byCaseNumber.values()], undefined, '\t'), { mode: 0o600 });
			fs.renameSync(tmp, stateFile);
		} catch {
			/* dashboard stays usable even if the write fails */
		}
	}

	return {
		async list(_tenant, filters = {}) {
			loadFromDisk();
			const term = filters.search ? String(filters.search).toLowerCase() : '';
			const tag = filters.tag ? String(filters.tag).toLowerCase() : '';
			const environmentId = filters.environmentId ?? '';
			return [...byCaseNumber.values()]
				.filter((record) => !record.deleted)
				.filter((record) => (term
					? `${record.caseNumber} ${record.title} ${(record.tags ?? []).join(' ')}`.toLowerCase().includes(term)
					: true))
				.filter((record) => (tag ? (record.tags ?? []).includes(tag) : true))
				.filter((record) => (environmentId ? (record.environmentIds ?? []).includes(environmentId) : true))
				.filter((record) => (filters.source ? (record.source ?? 'manual') === filters.source : true))
				.filter((record) => (filters.sourceRunId ? record.sourceRunId === filters.sourceRunId : true))
				.sort((left, right) => String(left.caseNumber).localeCompare(String(right.caseNumber)));
		},
		async get(_tenant, caseNumber) {
			loadFromDisk();
			const record = byCaseNumber.get(String(caseNumber));
			return record && !record.deleted ? record : null;
		},
		async create(_tenant, input) {
			loadFromDisk();
			const record = {
				id: randomUUID(),
				caseNumber: nextCaseNumber(byCaseNumber),
				...normalizeTestCaseInput(input),
				deleted: false,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			};
			byCaseNumber.set(record.caseNumber, record);
			persistNow();
			return record;
		},
		async update(_tenant, caseNumber, patch) {
			loadFromDisk();
			const record = byCaseNumber.get(String(caseNumber));
			if (!record || record.deleted) return null;
			if (patch.title !== undefined || patch.description !== undefined
				|| patch.expected !== undefined || patch.steps !== undefined || patch.tags !== undefined) {
				const merged = normalizeTestCaseInput({
					title: patch.title !== undefined ? patch.title : record.title,
					description: patch.description !== undefined ? patch.description : record.description,
					expected: patch.expected !== undefined ? patch.expected : record.expected,
					steps: patch.steps !== undefined ? patch.steps : record.steps,
					tags: patch.tags !== undefined ? patch.tags : record.tags,
					environmentIds: record.environmentIds
				});
				Object.assign(record, merged);
			}
			if (Array.isArray(patch.addEnvironmentIds)) {
				const additions = patch.addEnvironmentIds.map((id) => String(id).trim()).filter(Boolean);
				record.environmentIds = [...new Set([...(record.environmentIds ?? []), ...additions])];
			}
			if (Array.isArray(patch.removeEnvironmentIds)) {
				const removals = new Set(patch.removeEnvironmentIds.map((id) => String(id).trim()));
				record.environmentIds = (record.environmentIds ?? []).filter((id) => !removals.has(id));
			}
			record.updatedAt = new Date().toISOString();
			persistNow();
			return record;
		},
		/** Soft delete — history keeps resolving the title. */
		async remove(_tenant, caseNumber) {
			loadFromDisk();
			const record = byCaseNumber.get(String(caseNumber));
			if (!record || record.deleted) return null;
			record.deleted = true;
			record.updatedAt = new Date().toISOString();
			persistNow();
			return record;
		}
	};
}

// ---------------------------------------------------------------------------
// Service facade (validation + numbering over either backend)
// ---------------------------------------------------------------------------

export function createTestCaseService(backend, options = {}) {
	const environmentsService = options.environments ?? null;
	const tenantContext = options.tenantContext;
	const withTenant = (tenant) => tenant ?? tenantContext ?? {};

	return {
		async list(filters = {}) {
			return (await backend.list(withTenant(), filters)).map(rowToTestCase);
		},
		async get(caseNumber) {
			return rowToTestCase(await backend.get(withTenant(), caseNumber));
		},
		async create(input) {
			const normalized = normalizeTestCaseInput(input);
			await assertEnvironmentsAssignable(environmentsService, normalized.environmentIds);
			return rowToTestCase(await backend.create(withTenant(), normalized));
		},
		async update(caseNumber, patch = {}) {
			const existing = await backend.get(withTenant(), caseNumber);
			if (!existing) return null;
			if (Array.isArray(patch.addEnvironmentIds)) {
				const additions = patch.addEnvironmentIds.map((id) => String(id).trim()).filter(Boolean);
				// Validate every addition exists + active, but tolerate ids already
				// assigned (they get de-duplicated by the backends anyway).
				await assertEnvironmentsAssignable(environmentsService, additions, {
					allowMissing: existing.environmentIds ?? []
				});
			}
			// Normalize content patches so invalid values (e.g. empty title) fail
			// with 422 instead of reaching a DB CHECK as a 500.
			const normalizedPatch = { ...patch };
			if (patch.title !== undefined || patch.description !== undefined
				|| patch.expected !== undefined || patch.steps !== undefined || patch.tags !== undefined) {
				const merged = normalizeTestCaseInput({
					title: patch.title !== undefined ? patch.title : existing.title,
					description: patch.description !== undefined ? patch.description : existing.description,
					expected: patch.expected !== undefined ? patch.expected : existing.expected,
					steps: patch.steps !== undefined ? patch.steps : existing.steps,
					tags: patch.tags !== undefined ? patch.tags : existing.tags,
					environmentIds: existing.environmentIds ?? []
				});
				Object.assign(normalizedPatch, {
					title: merged.title, description: merged.description, expected: merged.expected,
					steps: merged.steps, tags: merged.tags
				});
			}
			return rowToTestCase(await backend.update(withTenant(), caseNumber, normalizedPatch));
		},
		async remove(caseNumber) {
			return rowToTestCase(await backend.remove(withTenant(), caseNumber));
		},
		/**
		 * Validate a run start against a case: case exists, not deleted, and the
		 * environment is assigned to it. Returns the case record for snapshotting.
		 */
		async resolveForRun(caseNumber, environmentId) {
			const record = rowToTestCase(await backend.get(withTenant(), caseNumber));
			if (!record) throw new TestCaseValidationError(`Unknown test case "${caseNumber}".`);
			if (environmentId && !record.environmentIds.includes(environmentId)) {
				throw new TestCaseValidationError(
					`Environment "${environmentId}" is not assigned to ${record.caseNumber}.`
				);
			}
			return record;
		}
	};
}
