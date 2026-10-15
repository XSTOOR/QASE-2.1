/**
 * Bug reporting (Phase 6): BUG-XXXX entities auto-associated with the run,
 * its environment (frozen snapshot) and the honest execution level.
 *
 * Two persistence backends behind one service facade (mirrors testCaseService):
 * local JSON file (.qase/bugs.json) and PostgreSQL (migration 020).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export class BugValidationError extends Error {
	constructor(message) {
		super(message);
		this.name = 'BugValidationError';
		this.code = 'QASE_BUG_INVALID';
	}
}

const TITLE_MAX = 300;
const DESCRIPTION_MAX = 4000;
const MAX_STEPS = 50;
const STEP_MAX = 1000;
const SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);
const STATUSES = Object.freeze(['open', 'in_progress', 'resolved', 'wont_fix', 'reopened']);

/** Normalize + validate a bug payload. Returns the bug record fields. */
export function normalizeBugInput(input = {}) {
	const title = typeof input.title === 'string' ? input.title.trim() : '';
	if (!title) throw new BugValidationError('title is required.');
	if (title.length > TITLE_MAX) throw new BugValidationError(`title must be at most ${TITLE_MAX} characters.`);
	const description = input.description === undefined || input.description === null
		? null
		: String(input.description).trim() || null;
	if (description && description.length > DESCRIPTION_MAX) {
		throw new BugValidationError(`description must be at most ${DESCRIPTION_MAX} characters.`);
	}
	const severity = input.severity === undefined || input.severity === null
		? 'medium'
		: String(input.severity).toLowerCase();
	if (!SEVERITIES.includes(severity)) {
		throw new BugValidationError(`severity must be one of: ${SEVERITIES.join(', ')}.`);
	}
	const status = input.status === undefined || input.status === null
		? 'open'
		: String(input.status).toLowerCase();
	if (!STATUSES.includes(status)) {
		throw new BugValidationError(`status must be one of: ${STATUSES.join(', ')}.`);
	}
	const steps = Array.isArray(input.steps) ? input.steps.map((step) => String(step).trim()).filter(Boolean) : [];
	if (steps.length > MAX_STEPS) throw new BugValidationError(`steps is limited to ${MAX_STEPS} entries.`);
	if (steps.some((step) => step.length > STEP_MAX)) {
		throw new BugValidationError(`each step must be at most ${STEP_MAX} characters.`);
	}
	const text = (value) => (value === undefined || value === null ? null : String(value).trim() || null);
	return {
		title,
		description,
		severity,
		status,
		category: text(input.category),
		expected: text(input.expected),
		actual: text(input.actual),
		steps
	};
}

function nextBugNumber(records) {
	let max = 0;
	for (const record of records.values()) {
		const match = /^BUG-(\d+)$/.exec(record.bugNumber ?? '');
		if (match) max = Math.max(max, Number(match[1]));
	}
	return `BUG-${String(max + 1).padStart(4, '0')}`;
}

function rowToBug(row) {
	if (!row) return null;
	return {
		id: row.id,
		bugNumber: row.bug_number ?? row.bugNumber,
		title: row.title,
		description: row.description ?? null,
		severity: row.severity,
		status: row.status,
		category: row.category ?? null,
		expected: row.expected ?? null,
		actual: row.actual ?? null,
		steps: row.steps ?? [],
		environmentId: row.environment_id ?? row.environmentId ?? null,
		environmentSnapshot: row.environment_snapshot ?? row.environmentSnapshot ?? null,
		executionLevel: row.execution_level ?? row.executionLevel ?? null,
		linkedRunId: row.linked_run_id ?? row.linkedRunId ?? null,
		linkedTestCaseId: row.linked_test_case_id ?? row.linkedTestCaseId ?? null,
		evidence: row.evidence ?? [],
		createdAt: row.created_at ?? row.createdAt ?? null,
		updatedAt: row.updated_at ?? row.updatedAt ?? null
	};
}

// ---------------------------------------------------------------------------
// Local JSON backend
// ---------------------------------------------------------------------------

export function createLocalBugBackend(options = {}) {
	const stateDir = options.stateDir ?? path.join(process.cwd(), '.qase');
	const stateFile = options.stateFile ?? path.join(stateDir, 'bugs.json');
	/** @type {Map<string, any>} */
	const byBugNumber = new Map();
	let loaded = false;

	function loadFromDisk() {
		if (loaded) return;
		loaded = true;
		try {
			const raw = fs.readFileSync(stateFile, 'utf8');
			const parsed = JSON.parse(raw);
			for (const record of Array.isArray(parsed) ? parsed : []) {
				if (record?.bugNumber) byBugNumber.set(record.bugNumber, record);
			}
		} catch {
			/* first boot — empty file */
		}
	}

	function persistNow() {
		try {
			fs.mkdirSync(stateDir, { recursive: true });
			const tmp = `${stateFile}.tmp-${process.pid}-${randomUUID()}`;
			fs.writeFileSync(tmp, JSON.stringify([...byBugNumber.values()], undefined, '\t'), { mode: 0o600 });
			fs.renameSync(tmp, stateFile);
		} catch {
			/* dashboard stays usable even if the write fails */
		}
	}

	return {
		async list(_tenant, filters = {}) {
			loadFromDisk();
			const term = filters.search ? String(filters.search).toLowerCase() : '';
			const status = filters.status ? String(filters.status).toLowerCase() : '';
			const severity = filters.severity ? String(filters.severity).toLowerCase() : '';
			const environmentId = filters.environmentId ?? '';
			return [...byBugNumber.values()]
				.filter((record) => (term
					? `${record.bugNumber} ${record.title} ${record.category ?? ''}`.toLowerCase().includes(term)
					: true))
				.filter((record) => (status ? record.status === status : true))
				.filter((record) => (severity ? record.severity === severity : true))
				.filter((record) => (environmentId ? record.environmentId === environmentId : true))
				.sort((left, right) => String(left.bugNumber).localeCompare(String(right.bugNumber)));
		},
		async get(_tenant, bugNumber) {
			loadFromDisk();
			return byBugNumber.get(String(bugNumber)) ?? null;
		},
		async create(_tenant, input) {
			loadFromDisk();
			const record = {
				id: randomUUID(),
				bugNumber: nextBugNumber(byBugNumber),
				...normalizeBugInput(input),
				environmentId: input.environmentId ?? null,
				environmentSnapshot: input.environmentSnapshot
					? structuredClone(input.environmentSnapshot)
					: null,
				executionLevel: input.executionLevel ?? null,
				linkedRunId: input.linkedRunId ?? null,
				linkedTestCaseId: input.linkedTestCaseId ?? null,
				evidence: Array.isArray(input.evidence) ? structuredClone(input.evidence) : [],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			};
			byBugNumber.set(record.bugNumber, record);
			persistNow();
			return record;
		},
		async update(_tenant, bugNumber, patch) {
			loadFromDisk();
			const record = byBugNumber.get(String(bugNumber));
			if (!record) return null;
			const merged = normalizeBugInput({
				title: patch.title !== undefined ? patch.title : record.title,
				description: patch.description !== undefined ? patch.description : record.description,
				severity: patch.severity !== undefined ? patch.severity : record.severity,
				status: patch.status !== undefined ? patch.status : record.status,
				category: patch.category !== undefined ? patch.category : record.category,
				expected: patch.expected !== undefined ? patch.expected : record.expected,
				actual: patch.actual !== undefined ? patch.actual : record.actual,
				steps: patch.steps !== undefined ? patch.steps : record.steps
			});
			Object.assign(record, merged);
			record.updatedAt = new Date().toISOString();
			persistNow();
			return record;
		},
		async remove(_tenant, bugNumber) {
			loadFromDisk();
			const record = byBugNumber.get(String(bugNumber));
			if (!record) return null;
			byBugNumber.delete(String(bugNumber));
			persistNow();
			return record;
		}
	};
}

// ---------------------------------------------------------------------------
// Service facade (validation + numbering + auto environment association)
// ---------------------------------------------------------------------------

export function createBugService(backend, options = {}) {
	const environmentsService = options.environments ?? null;
	const runsService = options.runs ?? null;
	const tenantContext = options.tenantContext;
	const withTenant = (tenant) => tenant ?? tenantContext ?? {};

	/**
	 * Auto-associate environment + execution level from the linked run when the
	 * caller did not pass them explicitly. The environment snapshot is frozen
	 * at bug-creation time so later catalog edits never rewrite bug history.
	 */
	async function associateFromRun(input) {
		if (!runsService || !input.linkedRunId) return input;
		const run = await runsService.get(input.linkedRunId).catch(() => null);
		if (!run) return input;
		const out = { ...input };
		if (!out.environmentId && run.environmentId) out.environmentId = run.environmentId;
		if (!out.environmentSnapshot && run.environmentSnapshot) {
			out.environmentSnapshot = structuredClone(run.environmentSnapshot);
		}
		if (!out.executionLevel) {
			out.executionLevel = run.executionLevel
				?? run.runtimeFacts?.executionLevel
				?? run.executionLevelActual
				?? null;
		}
		if (!out.linkedTestCaseId && run.testCaseId) out.linkedTestCaseId = run.testCaseId;
		return out;
	}

	return {
		async list(filters = {}) {
			return (await backend.list(withTenant(), filters)).map(rowToBug);
		},
		async get(bugNumber) {
			return rowToBug(await backend.get(withTenant(), bugNumber));
		},
		async create(input = {}) {
			const normalized = { ...normalizeBugInput(input) };
			// Freeze a snapshot of the environment at bug time when only an id
			// was given and the environment still exists.
			if (input.environmentId && !input.environmentSnapshot && environmentsService) {
				const env = await environmentsService.get(input.environmentId).catch(() => null);
				if (env) {
					normalized.environmentSnapshot = structuredClone(env);
					input = { ...input, environmentSnapshot: normalized.environmentSnapshot };
				}
			}
			const enriched = await associateFromRun({ ...normalized, ...input });
			return rowToBug(await backend.create(withTenant(), enriched));
		},
		async update(bugNumber, patch = {}) {
			const existing = await backend.get(withTenant(), bugNumber);
			if (!existing) return null;
			return rowToBug(await backend.update(withTenant(), bugNumber, patch));
		},
		async remove(bugNumber) {
			return rowToBug(await backend.remove(withTenant(), bugNumber));
		},
		SEVERITIES,
		STATUSES
	};
}
