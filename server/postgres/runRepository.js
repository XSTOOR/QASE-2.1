import { randomUUID } from 'node:crypto';

/**
 * PostgreSQL persistence for the current Qase run aggregate.
 *
 * The repository is deliberately transport-free: it commits normalized state
 * and durable run events, but never publishes SSE messages. The application
 * service may publish only after this transaction has committed.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTEXT_KEYS = [
	'organizationId', 'organizationSlug', 'organizationName',
	'projectId', 'projectSlug', 'projectName',
	'actorUserId', 'actorEmail', 'actorName', 'actorRole'
];
const UNTRUSTED_CONTEXT_KEYS = [
	'body', 'headers', 'params', 'query', 'request', 'tenant', 'tenantId'
];

const BEGIN = 'BEGIN';
const COMMIT = 'COMMIT';
const ROLLBACK = 'ROLLBACK';
const ACTOR_TYPES = new Set(['user', 'agent', 'system']);

export class RunVersionConflictError extends Error {
	constructor(runId, expectedVersion) {
		super(`Run ${runId} changed after version ${expectedVersion}.`);
		this.name = 'RunVersionConflictError';
		this.code = 'QASE_RUN_VERSION_CONFLICT';
		this.runId = runId;
		this.expectedVersion = expectedVersion;
	}
}

function trustedTenantContext(value) {
	if (!value || typeof value !== 'object' || !Object.isFrozen(value)) {
		throw new TypeError('PostgreSQL run storage requires a frozen trusted tenant context.');
	}
	for (const key of UNTRUSTED_CONTEXT_KEYS) {
		if (Object.hasOwn(value, key)) {
			throw new TypeError('PostgreSQL run storage rejects request-supplied tenant context.');
		}
	}
	for (const key of CONTEXT_KEYS) {
		if (typeof value[key] !== 'string' || value[key].trim() === '') {
			throw new TypeError(`Trusted tenant context is missing ${key}.`);
		}
	}
	if (!UUID_PATTERN.test(value.organizationId)
		|| !UUID_PATTERN.test(value.projectId)
		|| !UUID_PATTERN.test(value.actorUserId)) {
		throw new TypeError('Trusted tenant context must contain canonical organization, project and actor UUIDs.');
	}
	return Object.freeze(Object.fromEntries(CONTEXT_KEYS.map(key => [key, value[key]])));
}

function nonNegativeInteger(value, label) {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 0) {
		throw new TypeError(`${label} must be a non-negative safe integer.`);
	}
	return number;
}

function requireRun(session) {
	if (!session || typeof session !== 'object' || typeof session.id !== 'string' || !UUID_PATTERN.test(session.id)) {
		throw new TypeError('A run aggregate with a canonical UUID is required.');
	}
	return session;
}

function asDate(value, fallback) {
	if (value === undefined || value === null) return new Date(fallback);
	const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
	if (Number.isNaN(result.getTime())) {
		throw new TypeError('Run timestamps must be valid dates or epoch values.');
	}
	return result;
}

function epoch(value) {
	if (value === undefined || value === null) return undefined;
	if (value instanceof Date) return value.getTime();
	if (typeof value === 'number') return value;
	const numeric = Number(value);
	if (Number.isFinite(numeric) && String(value).trim() !== '') return numeric;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function optional(target, key, value) {
	if (value !== undefined && value !== null) target[key] = value;
	return target;
}

function json(value) {
	return value === undefined ? null : value;
}

function names(value) {
	if (!Array.isArray(value)) return [];
	return value
		.filter(name => typeof name === 'string' && name.trim() !== '')
		.map(name => name.trim());
}

function eventOptions(options, fallbackDate, tenant) {
	const type = options?.eventType;
	if (type !== undefined && (typeof type !== 'string' || type.trim() === '')) {
		throw new TypeError('eventType must be a non-empty string when supplied.');
	}
	const actorType = options?.actorType ?? 'system';
	if (!ACTOR_TYPES.has(actorType)) {
		throw new TypeError('actorType must be user, agent, or system.');
	}
	let actorUserId = null;
	if (actorType === 'user') {
		actorUserId = options?.actorUserId ?? tenant.actorUserId;
		if (typeof actorUserId !== 'string' || !UUID_PATTERN.test(actorUserId)) {
			throw new TypeError('User event attribution requires a trusted canonical actor UUID.');
		}
	} else if (options?.actorUserId !== undefined && options.actorUserId !== null) {
		// The schema intentionally forbids a user identity on agent/system events.
		throw new TypeError('Agent and system events cannot carry a user actor ID.');
	}
	return {
		type: type?.trim(),
		payload: json(options?.payload ?? {}),
		createdAt: asDate(options?.eventTs, fallbackDate),
		actorType,
		actorUserId
	};
}

async function setTenantContext(client, tenant) {
	await client.query(
		"SELECT set_config('qase.organization_id', $1, true), set_config('qase.project_id', $2, true)",
		[tenant.organizationId, tenant.projectId]
	);
}

function groupByRun(rows) {
	const grouped = new Map();
	for (const row of rows ?? []) {
		let entries = grouped.get(row.run_id);
		if (!entries) {
			entries = [];
			grouped.set(row.run_id, entries);
		}
		entries.push(row);
	}
	return grouped;
}

function hydrateMessage(row) {
	return optional({
		id: row.id,
		ts: epoch(row.created_at),
		role: row.role,
		text: row.content ?? ''
	}, 'kind', row.kind);
}

function hydrateActivity(row) {
	const activity = { id: row.id, ts: epoch(row.created_at), status: row.status };
	optional(activity, 'type', row.type);
	optional(activity, 'toolName', row.tool_name);
	optional(activity, 'label', row.label);
	optional(activity, 'detail', row.detail);
	optional(activity, 'input', row.input);
	optional(activity, 'error', row.error);
	optional(activity, 'summary', row.summary);
	return activity;
}

function hydrateFinding(row) {
	const finding = {
		id: row.id,
		ts: epoch(row.created_at),
		title: row.title,
		severity: row.severity,
		category: row.category,
		steps: row.steps ?? [],
		expected: row.expected,
		actual: row.actual
	};
	optional(finding, 'url', row.page_url);
	optional(finding, 'evidence', row.evidence);
	return finding;
}

function hydrateReport(row) {
	if (!row) return undefined;
	return {
		ts: epoch(row.published_at),
		verdict: row.verdict,
		summary: row.summary,
		covered: row.covered ?? [],
		notCovered: row.not_covered ?? [],
		recommendations: row.recommendations ?? [],
		targetUrl: row.target_url ?? undefined,
		findings: Number(row.finding_count ?? 0),
		bySeverity: row.severity_counts ?? {}
	};
}

function hydrateRun(row, children) {
	const session = {
		id: row.id,
		title: row.title,
		createdAt: epoch(row.created_at),
		updatedAt: epoch(row.updated_at),
		status: row.status,
		targetUrl: row.target_url ?? undefined,
		messages: (children.messages.get(row.id) ?? []).map(hydrateMessage),
		activities: (children.activities.get(row.id) ?? []).map(hydrateActivity),
		findings: (children.findings.get(row.id) ?? []).map(hydrateFinding),
		todos: (children.planItems.get(row.id) ?? []).map(item => ({ text: item.text, status: item.status })),
		report: hydrateReport(children.reports.get(row.id)?.[0]),
		pendingQuestion: row.pending_question ?? undefined,
		contextUsage: row.context_usage ?? undefined,
		secretNames: names(row.secret_names)
	};
	return { session, version: Number(row.lock_version) };
}

async function hydrateRows(client, tenant, runRows) {
	if (!runRows?.length) return [];
	const ids = runRows.map(row => row.id);
	const childScope = [tenant.organizationId, tenant.projectId, ids];
	const [messages, activities, planItems, findings, reports] = await Promise.all([
		client.query(
			`SELECT run_id, id, role, kind, content, actor_user_id, created_at
			 FROM qa_messages
			 WHERE organization_id = $1 AND project_id = $2 AND run_id = ANY($3::uuid[])
			 ORDER BY run_id, ordinal`, childScope),
		client.query(
			`SELECT run_id, id, type, tool_name, label, detail, input, status, error, summary, created_at
			 FROM qa_activities
			 WHERE organization_id = $1 AND project_id = $2 AND run_id = ANY($3::uuid[])
			 ORDER BY run_id, ordinal`, childScope),
		client.query(
			`SELECT run_id, position, text, status
			 FROM qa_plan_items
			 WHERE organization_id = $1 AND project_id = $2 AND run_id = ANY($3::uuid[])
			 ORDER BY run_id, position`, childScope),
		client.query(
			`SELECT run_id, id, title, severity, category, page_url, steps, expected, actual, evidence, created_at
			 FROM qa_findings
			 WHERE organization_id = $1 AND project_id = $2 AND run_id = ANY($3::uuid[])
			 ORDER BY run_id, ordinal`, childScope),
		client.query(
			`SELECT run_id, verdict, summary, covered, not_covered, recommendations,
				target_url, finding_count, severity_counts, published_at
			 FROM qa_reports
			 WHERE organization_id = $1 AND project_id = $2 AND run_id = ANY($3::uuid[])
				AND is_current = true
			 ORDER BY run_id`, childScope)
	]);
	const children = {
		messages: groupByRun(messages.rows),
		activities: groupByRun(activities.rows),
		planItems: groupByRun(planItems.rows),
		findings: groupByRun(findings.rows),
		reports: groupByRun(reports.rows)
	};
	return runRows.map(row => hydrateRun(row, children));
}

async function replaceChildren(client, tenant, session, fallbackDate) {
	const scope = [tenant.organizationId, tenant.projectId, session.id];
	for (const table of ['qa_messages', 'qa_activities', 'qa_plan_items', 'qa_findings', 'qa_reports']) {
		await client.query(
			`DELETE FROM ${table} WHERE organization_id = $1 AND project_id = $2 AND run_id = $3`,
			scope
		);
	}

	for (const [ordinal, message] of (session.messages ?? []).entries()) {
		await client.query(
			`INSERT INTO qa_messages (
				organization_id, project_id, run_id, id, ordinal, role, kind, content,
				actor_user_id, created_at, updated_at
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
			[
				...scope, message.id, ordinal, message.role, message.kind ?? null,
				String(message.text ?? ''), message.actorUserId ?? null,
				asDate(message.ts, fallbackDate)
			]
		);
	}

	for (const [ordinal, activity] of (session.activities ?? []).entries()) {
		await client.query(
			`INSERT INTO qa_activities (
				organization_id, project_id, run_id, id, ordinal, type, tool_name, label,
				detail, input, status, error, summary, created_at, updated_at
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
			[
				...scope, activity.id, ordinal, activity.type ?? null,
				activity.toolName ?? null,
				String(activity.label ?? activity.toolName ?? activity.type ?? 'Activity'),
				activity.detail ?? null,
				json(activity.input), activity.status ?? 'done', activity.error ?? null,
				activity.summary ?? null, asDate(activity.ts, fallbackDate)
			]
		);
	}

	for (const [position, item] of (session.todos ?? []).entries()) {
		const itemId = typeof item.id === 'string' && UUID_PATTERN.test(item.id) ? item.id : randomUUID();
		await client.query(
			`INSERT INTO qa_plan_items (
				organization_id, project_id, run_id, id, position, text, status
			) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
			[...scope, itemId, position, String(item.text ?? ''), item.status ?? 'pending']
		);
	}

	for (const [ordinal, finding] of (session.findings ?? []).entries()) {
		await client.query(
			`INSERT INTO qa_findings (
				organization_id, project_id, run_id, id, ordinal, title, severity,
				category, page_url, steps, expected, actual, evidence, created_at
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
			[
				...scope, finding.id, ordinal, String(finding.title ?? ''),
				finding.severity ?? 'medium', finding.category ?? 'general',
				finding.url ?? null, Array.isArray(finding.steps) ? finding.steps.map(String) : [],
				String(finding.expected ?? ''), String(finding.actual ?? ''),
				finding.evidence ?? null, asDate(finding.ts, fallbackDate)
			]
		);
	}

	if (session.report) {
		const report = session.report;
		await client.query(
			`INSERT INTO qa_reports (
				organization_id, project_id, run_id, id, version, is_current, verdict,
				summary, covered, not_covered, recommendations, target_url,
				finding_count, severity_counts, published_at
			) VALUES ($1,$2,$3,$4,1,true,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
			[
				...scope, session.id, report.verdict ?? 'pass_with_issues',
				String(report.summary ?? ''), Array.isArray(report.covered) ? report.covered.map(String) : [],
				Array.isArray(report.notCovered) ? report.notCovered.map(String) : [],
				Array.isArray(report.recommendations) ? report.recommendations.map(String) : [],
				report.targetUrl ?? session.targetUrl ?? null,
				Number(report.findings ?? session.findings?.length ?? 0), json(report.bySeverity ?? {}),
				asDate(report.ts, fallbackDate)
			]
		);
	}
}

async function appendEvent(client, tenant, runId, sequence, event, createdAt) {
	if (!event.type) return;
	await client.query(
		`INSERT INTO qa_run_events (
			organization_id, project_id, run_id, sequence, event_type, payload_version,
			payload, actor_type, actor_user_id, created_at
		) VALUES ($1,$2,$3,$4,$5,1,$6,$7,$8,$9)`,
		[
			tenant.organizationId, tenant.projectId, runId, sequence,
			event.type, event.payload, event.actorType, event.actorUserId, createdAt
		]
	);
}

async function insertAggregate(client, tenant, session, event, nowValue) {
	const updatedAt = asDate(session.updatedAt, nowValue);
	const createdAt = asDate(session.createdAt, updatedAt);
	const nextEventSequence = event.type ? 2 : 1;
	const result = await client.query(
		`INSERT INTO qa_runs (
			id, organization_id, project_id, created_by_user_id, title, target_url,
			status, status_detail, pending_question, context_usage, secret_names,
			message_count, finding_count, lock_version, next_event_sequence,
			created_at, updated_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,$12,0,$13,$14,$15)
		 RETURNING lock_version, updated_at`,
		[
			session.id, tenant.organizationId, tenant.projectId, tenant.actorUserId,
			String(session.title ?? 'New test run'), session.targetUrl ?? null,
			session.status ?? 'idle', json(session.pendingQuestion), json(session.contextUsage),
			names(session.secretNames), session.messages?.length ?? 0,
			session.findings?.length ?? 0, nextEventSequence, createdAt, updatedAt
		]
	);
	await replaceChildren(client, tenant, session, updatedAt);
	await appendEvent(client, tenant, session.id, 1, event, event.createdAt);
	return {
		version: Number(result.rows[0].lock_version),
		updatedAt: epoch(result.rows[0].updated_at)
	};
}

export function createPostgresRunRepository({ pool, tenantContext, now = () => Date.now() } = {}) {
	if (!pool || typeof pool.connect !== 'function' || typeof pool.end !== 'function') {
		throw new TypeError('A PostgreSQL pool with connect() and end() is required.');
	}
	if (typeof now !== 'function') {
		throw new TypeError('now must be a function.');
	}
	const tenant = trustedTenantContext(tenantContext);
	let closePromise;

	async function transaction(work) {
		const client = await pool.connect();
		let began = false;
		try {
			await client.query(BEGIN);
			began = true;
			await setTenantContext(client, tenant);
			const result = await work(client);
			await client.query(COMMIT);
			return result;
		} catch (error) {
			if (began) {
				try {
					await client.query(ROLLBACK);
				} catch {
					// Preserve the operation error; a poisoned connection is released below.
				}
			}
			throw error;
		} finally {
			client.release();
		}
	}

	async function bootstrapTenant() {
		return transaction(async client => {
			const timestamp = asDate(now(), Date.now());
			await client.query(
				`INSERT INTO organizations (id, slug, name, status, created_at, updated_at)
				 VALUES ($1,$2,$3,'active',$4,$4)
				 ON CONFLICT (id) DO UPDATE SET
					slug = EXCLUDED.slug, name = EXCLUDED.name, status = 'active', updated_at = EXCLUDED.updated_at`,
				[tenant.organizationId, tenant.organizationSlug, tenant.organizationName, timestamp]
			);
			await client.query(
				`INSERT INTO users (
					id, email, normalized_email, display_name, status, created_at, updated_at
				) VALUES ($1,$2,$3,$4,'active',$5,$5)
				 ON CONFLICT (id) DO UPDATE SET
					email = EXCLUDED.email, normalized_email = EXCLUDED.normalized_email,
					display_name = EXCLUDED.display_name, status = 'active', updated_at = EXCLUDED.updated_at`,
				[
					tenant.actorUserId, tenant.actorEmail,
					tenant.actorEmail.trim().toLowerCase(), tenant.actorName, timestamp
				]
			);
			await client.query(
				`INSERT INTO organization_memberships (
					organization_id, user_id, role, status, created_at, updated_at
				) VALUES ($1,$2,$3,'active',$4,$4)
				 ON CONFLICT (organization_id, user_id) DO UPDATE SET
					role = EXCLUDED.role, status = 'active', updated_at = EXCLUDED.updated_at`,
				[tenant.organizationId, tenant.actorUserId, tenant.actorRole, timestamp]
			);
			await client.query(
				`INSERT INTO projects (id, organization_id, slug, name, status, created_at, updated_at)
				 VALUES ($1,$2,$3,$4,'active',$5,$5)
				 ON CONFLICT (id) DO UPDATE SET
					slug = EXCLUDED.slug, name = EXCLUDED.name, status = 'active', updated_at = EXCLUDED.updated_at`,
				[tenant.projectId, tenant.organizationId, tenant.projectSlug, tenant.projectName, timestamp]
			);
			return {
				ready: true,
				organizationId: tenant.organizationId,
				projectId: tenant.projectId,
				actorUserId: tenant.actorUserId
			};
		});
	}

	async function loadAll() {
		return transaction(async client => {
			const scope = [tenant.organizationId, tenant.projectId];
			const runs = await client.query(
				`SELECT id, title, target_url, status, pending_question, context_usage,
					secret_names, created_at, updated_at, lock_version
				 FROM qa_runs
				 WHERE organization_id = $1 AND project_id = $2 AND deleted_at IS NULL
				 ORDER BY updated_at DESC, id ASC`,
				scope
			);
			return hydrateRows(client, tenant, runs.rows);
		});
	}

	async function get(runId) {
		if (typeof runId !== 'string' || !UUID_PATTERN.test(runId)) {
			throw new TypeError('Run ID must be a canonical UUID.');
		}
		return transaction(async client => {
			const result = await client.query(
				`SELECT id, title, target_url, status, pending_question, context_usage,
					secret_names, created_at, updated_at, lock_version
				 FROM qa_runs
				 WHERE organization_id = $1 AND project_id = $2 AND id = $3
					AND deleted_at IS NULL`,
				[tenant.organizationId, tenant.projectId, runId]
			);
			const hydrated = await hydrateRows(client, tenant, result.rows);
			return hydrated[0];
		});
	}

	async function list() {
		return transaction(async client => {
			const result = await client.query(
				`SELECT id, title, status, target_url, created_at, updated_at,
					message_count, finding_count
				 FROM qa_runs
				 WHERE organization_id = $1 AND project_id = $2 AND deleted_at IS NULL
				 ORDER BY updated_at DESC, id ASC`,
				[tenant.organizationId, tenant.projectId]
			);
			return (result.rows ?? []).map(row => ({
				id: row.id,
				title: row.title,
				status: row.status,
				targetUrl: row.target_url ?? undefined,
				createdAt: epoch(row.created_at),
				updatedAt: epoch(row.updated_at),
				findingCount: Number(row.finding_count ?? 0),
				messageCount: Number(row.message_count ?? 0)
			}));
		});
	}

	async function create(session, options = {}) {
		requireRun(session);
		return transaction(async client => {
			const timestamp = now();
			return insertAggregate(client, tenant, session, eventOptions(options, timestamp, tenant), timestamp);
		});
	}

	async function importBatch({ sourceHash, sourcePath, importerVersion, runs } = {}) {
		for (const [label, value] of Object.entries({ sourceHash, sourcePath, importerVersion })) {
			if (typeof value !== 'string' || value.trim() === '') {
				throw new TypeError(`${label} must be a non-empty string.`);
			}
		}
		if (!Array.isArray(runs)) {
			throw new TypeError('runs must be an array.');
		}
		const ids = new Set();
		for (const run of runs) {
			requireRun(run);
			if (ids.has(run.id)) {
				throw new TypeError(`Legacy import contains duplicate run ID ${run.id}.`);
			}
			ids.add(run.id);
		}

		return transaction(async client => {
			await client.query(
				'SELECT pg_advisory_xact_lock(hashtextextended($1, 0)) AS locked',
				[`${tenant.organizationId}:${tenant.projectId}:${sourceHash.trim()}`]
			);
			const marker = await client.query(
				`SELECT run_count FROM qa_legacy_imports
				 WHERE source_hash = $1 AND organization_id = $2 AND project_id = $3`,
				[sourceHash.trim(), tenant.organizationId, tenant.projectId]
			);
			if (marker.rows?.length) {
				return { alreadyImported: true, imported: 0 };
			}

			if (runs.length > 0) {
				const collisions = await client.query(
					`SELECT id FROM qa_runs
					 WHERE organization_id = $1 AND project_id = $2 AND id = ANY($3::uuid[])`,
					[tenant.organizationId, tenant.projectId, [...ids]]
				);
				if (collisions.rows?.length) {
					const error = new Error(`Legacy run ID already exists: ${collisions.rows[0].id}.`);
					error.code = 'QASE_LEGACY_RUN_COLLISION';
					throw error;
				}
			}

			const importedAt = asDate(now(), Date.now());
			for (const run of runs) {
				await insertAggregate(client, tenant, run, {
					type: 'legacy.run_imported',
					payload: { sourceHash: sourceHash.trim() },
					createdAt: asDate(run.updatedAt, importedAt),
					actorType: 'system',
					actorUserId: null
				}, importedAt);
			}

			await client.query(
				`INSERT INTO qa_legacy_imports (
					source_hash, organization_id, project_id, importer_version,
					source_path, run_count, imported_at
				) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				[
					sourceHash.trim(), tenant.organizationId, tenant.projectId,
					importerVersion.trim(), sourcePath.trim(), runs.length, importedAt
				]
			);
			return { alreadyImported: false, imported: runs.length };
		});
	}

	async function save(session, options = {}) {
		requireRun(session);
		const expectedVersion = nonNegativeInteger(options.expectedVersion, 'expectedVersion');
		return transaction(async client => {
			const updatedAt = asDate(now(), Date.now());
			const event = eventOptions(options, updatedAt, tenant);
			const eventIncrement = event.type ? 1 : 0;
			const result = await client.query(
				`UPDATE qa_runs SET
					title = $4, target_url = $5, status = $6, pending_question = $7,
					context_usage = $8, secret_names = $9, message_count = $10,
					finding_count = $11, updated_at = $12, lock_version = lock_version + 1,
					next_event_sequence = next_event_sequence + $13
				 WHERE organization_id = $1 AND project_id = $2 AND id = $3
					AND lock_version = $14 AND deleted_at IS NULL
				 RETURNING lock_version, updated_at, next_event_sequence`,
				[
					tenant.organizationId, tenant.projectId, session.id,
					String(session.title ?? 'New test run'), session.targetUrl ?? null,
					session.status ?? 'idle', json(session.pendingQuestion), json(session.contextUsage),
					names(session.secretNames), session.messages?.length ?? 0,
					session.findings?.length ?? 0, updatedAt, eventIncrement, expectedVersion
				]
			);
			if (!result.rows?.length) {
				throw new RunVersionConflictError(session.id, expectedVersion);
			}
			await replaceChildren(client, tenant, session, updatedAt);
			const nextSequence = Number(result.rows[0].next_event_sequence);
			await appendEvent(client, tenant, session.id, nextSequence - eventIncrement, event, event.createdAt);
			return {
				version: Number(result.rows[0].lock_version),
				updatedAt: epoch(result.rows[0].updated_at)
			};
		});
	}

	async function deleteRun(id, options = {}) {
		if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
			throw new TypeError('Run ID must be a canonical UUID.');
		}
		const hasVersion = options.expectedVersion !== undefined;
		const expectedVersion = hasVersion
			? nonNegativeInteger(options.expectedVersion, 'expectedVersion')
			: undefined;
		return transaction(async client => {
			const parameters = [tenant.organizationId, tenant.projectId, id];
			const result = await client.query(
				`DELETE FROM qa_runs
				 WHERE organization_id = $1 AND project_id = $2 AND id = $3${hasVersion ? ' AND lock_version = $4' : ''}
				 RETURNING id`,
				hasVersion ? [...parameters, expectedVersion] : parameters
			);
			if (result.rows?.length) return true;
			if (!hasVersion) return false;

			const existing = await client.query(
				`SELECT lock_version FROM qa_runs
				 WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
				parameters
			);
			if (existing.rows?.length) throw new RunVersionConflictError(id, expectedVersion);
			return false;
		});
	}

	async function check() {
		return transaction(async client => {
			await client.query(
				`SELECT 1 FROM qa_runs
				 WHERE organization_id = $1 AND project_id = $2
				 LIMIT 1`,
				[tenant.organizationId, tenant.projectId]
			);
			return {
				ready: true,
				organizationId: tenant.organizationId,
				projectId: tenant.projectId
			};
		});
	}

	function close() {
		closePromise ??= Promise.resolve().then(() => pool.end());
		return closePromise;
	}

	return {
		bootstrapTenant,
		loadAll,
		get,
		list,
		create,
		importBatch,
		save,
		delete: deleteRun,
		check,
		close
	};
}
