const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REGION_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CELL_STATUSES = new Set(['active', 'draining', 'disabled']);

function uuid(value, label) {
	if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new TypeError(`${label} must be a canonical UUID.`);
	return value.toLowerCase();
}
function region(value, optional = false) {
	if (optional && (value === undefined || value === null || value === '')) return undefined;
	const result = String(value ?? '').trim().toLowerCase();
	if (!REGION_PATTERN.test(result)) throw new TypeError('region must be a DNS-safe slug.');
	return result;
}
function name(value) {
	const result = String(value ?? '').trim();
	if (!result || result.length > 120 || /[\u0000-\u001f\u007f]/.test(result)) throw new TypeError('cell name is invalid.');
	return result;
}
function baseUrl(value) {
	let parsed;
	try { parsed = new URL(String(value ?? '')); } catch { throw new TypeError('baseUrl must be a valid URL.'); }
	if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
		throw new TypeError('baseUrl must be an HTTPS origin without credentials, path, query, or fragment.');
	}
	return parsed.origin;
}
function integer(value, fallback, minimum, maximum, label) {
	const result = value === undefined ? fallback : Number(value);
	if (!Number.isInteger(result) || result < minimum || result > maximum) throw new TypeError(`${label} is invalid.`);
	return result;
}
function finite(value, fallback, maximum, label) {
	const result = value === undefined ? fallback : Number(value);
	if (!Number.isFinite(result) || result < 0 || result > maximum) throw new TypeError(`${label} is invalid.`);
	return result;
}
function cellStatus(value) {
	const result = String(value ?? 'active').trim().toLowerCase();
	if (!CELL_STATUSES.has(result)) throw new TypeError('cell status is invalid.');
	return result;
}
function hydrateCell(row) {
	return row ? {
		id: row.id, name: row.name, region: row.region, baseUrl: row.base_url,
		status: row.status, capacityWeight: Number(row.capacity_weight),
		heartbeatAt: new Date(row.heartbeat_at).getTime(),
		queueDepth: Number(row.observed_queue_depth),
		oldestQueuedAgeSeconds: Number(row.observed_oldest_queue_age_seconds),
		version: Number(row.lock_version)
	} : undefined;
}

async function audit(client, { eventType, entityKind, entityId, requestId, payload }) {
	if (requestId !== undefined) uuid(requestId, 'requestId');
	await client.query(
		`INSERT INTO qase_control_events
		 (event_type, entity_kind, entity_id, correlation_id, payload)
		 VALUES ($1, $2, $3, $4, $5::jsonb)`,
		[eventType, entityKind, entityId, requestId ?? null, JSON.stringify(payload ?? {})]
	);
}

export function createControlPlaneRepository(options = {}) {
	const pool = options.pool;
	if (!pool?.connect) throw new TypeError('Control-plane repository requires a PostgreSQL pool.');
	const staleAfterSeconds = integer(options.staleAfterSeconds, 90, 15, 600, 'staleAfterSeconds');
	let closing;

	async function transaction(work) {
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			const result = await work(client);
			await client.query('COMMIT');
			return result;
		} catch (error) {
			await client.query('ROLLBACK').catch(() => undefined);
			throw error;
		} finally { client.release(); }
	}

	async function selectCell(client, cellId, preferredRegion) {
		if (cellId) {
			const selected = await client.query(
				`SELECT * FROM qase_cells WHERE id = $1 AND status = 'active'
				 AND heartbeat_at > CURRENT_TIMESTAMP - ($2 * INTERVAL '1 second') FOR UPDATE`,
				[uuid(cellId, 'cellId'), staleAfterSeconds]
			);
			return selected.rows[0];
		}
		const selected = await client.query(
			`SELECT c.* FROM qase_cells c
			 LEFT JOIN LATERAL (
			  SELECT COUNT(*)::int AS placements FROM qase_project_placements p
			  WHERE p.cell_id = c.id AND p.status = 'active'
			 ) assigned ON true
			 WHERE c.status = 'active'
			 AND c.heartbeat_at > CURRENT_TIMESTAMP - ($2 * INTERVAL '1 second')
			 AND ($1::text IS NULL OR c.region = $1)
			 ORDER BY ((assigned.placements + c.observed_queue_depth)::numeric / c.capacity_weight),
			 c.observed_oldest_queue_age_seconds, c.id
			 FOR UPDATE OF c SKIP LOCKED LIMIT 1`,
			[region(preferredRegion, true) ?? null, staleAfterSeconds]
		);
		return selected.rows[0];
	}

	return Object.freeze({
		async upsertCell(input, context = {}) {
			const values = {
				id: uuid(input?.id, 'cellId'), name: name(input?.name), region: region(input?.region),
				baseUrl: baseUrl(input?.baseUrl), status: cellStatus(input?.status),
				capacityWeight: integer(input?.capacityWeight, 100, 1, 1000, 'capacityWeight')
			};
			return transaction(async client => {
				const result = await client.query(
					`INSERT INTO qase_cells (id, name, region, base_url, status, capacity_weight)
					 VALUES ($1, $2, $3, $4, $5, $6)
					 ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, region = EXCLUDED.region,
					 base_url = EXCLUDED.base_url, status = EXCLUDED.status,
					 capacity_weight = EXCLUDED.capacity_weight, lock_version = qase_cells.lock_version + 1,
					 updated_at = CURRENT_TIMESTAMP RETURNING *`,
					[values.id, values.name, values.region, values.baseUrl, values.status, values.capacityWeight]
				);
				const cell = hydrateCell(result.rows[0]);
				await audit(client, {
					eventType: 'cell.upserted', entityKind: 'cell', entityId: values.id,
					requestId: context.requestId,
					payload: { region: values.region, status: values.status, capacityWeight: values.capacityWeight }
				});
				return cell;
			});
		},

		async heartbeat(cellId, observations = {}) {
			const queueDepth = integer(observations.queueDepth, 0, 0, 10_000_000, 'queueDepth');
			const age = finite(observations.oldestQueuedAgeSeconds, 0, 31_536_000, 'oldestQueuedAgeSeconds');
			return transaction(async client => {
				const result = await client.query(
					`UPDATE qase_cells SET heartbeat_at = CURRENT_TIMESTAMP,
					 observed_queue_depth = $2, observed_oldest_queue_age_seconds = $3,
					 updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
					[uuid(cellId, 'cellId'), queueDepth, age]
				);
				return hydrateCell(result.rows[0]);
			});
		},

		async place({ organizationId, projectId, cellId, preferredRegion, requestId }) {
			const organization = uuid(organizationId, 'organizationId');
			const project = uuid(projectId, 'projectId');
			if (organization === project) throw new TypeError('organizationId and projectId must differ.');
			return transaction(async client => {
				const cell = await selectCell(client, cellId, preferredRegion);
				if (!cell) {
					const error = new Error('No healthy Qase cell is available for this placement.');
					error.code = 'QASE_NO_HEALTHY_CELL';
					throw error;
				}
				await client.query(
					`INSERT INTO qase_project_placements (organization_id, project_id, cell_id, status)
					 VALUES ($1, $2, $3, 'active') ON CONFLICT (organization_id, project_id)
					 DO UPDATE SET cell_id = EXCLUDED.cell_id, status = 'active', updated_at = CURRENT_TIMESTAMP`,
					[organization, project, cell.id]
				);
				await audit(client, {
					eventType: 'placement.upserted', entityKind: 'placement',
					entityId: `${organization}:${project}`, requestId,
					payload: { cellId: cell.id, preferredRegion: region(preferredRegion, true) ?? null }
				});
				return { organizationId: organization, projectId: project, cell: hydrateCell(cell) };
			});
		},

		async resolve(organizationId, projectId) {
			return transaction(async client => {
				const result = await client.query(
					`SELECT c.* FROM qase_project_placements p JOIN qase_cells c ON c.id = p.cell_id
					 WHERE p.organization_id = $1 AND p.project_id = $2 AND p.status = 'active'
					 AND c.status = 'active'
					 AND c.heartbeat_at > CURRENT_TIMESTAMP - ($3 * INTERVAL '1 second')`,
					[uuid(organizationId, 'organizationId'), uuid(projectId, 'projectId'), staleAfterSeconds]
				);
				return hydrateCell(result.rows[0]);
			});
		},

		async disablePlacement(organizationId, projectId, context = {}) {
			return transaction(async client => {
				const organization = uuid(organizationId, 'organizationId');
				const project = uuid(projectId, 'projectId');
				const result = await client.query(
					`UPDATE qase_project_placements SET status = 'disabled', updated_at = CURRENT_TIMESTAMP
					 WHERE organization_id = $1 AND project_id = $2 AND status <> 'disabled' RETURNING project_id`,
					[organization, project]
				);
				if (result.rowCount > 0) await audit(client, {
					eventType: 'placement.disabled', entityKind: 'placement',
					entityId: `${organization}:${project}`, requestId: context.requestId,
					payload: {}
				});
				return result.rowCount > 0;
			});
		},

		async check() {
			return transaction(async client => { await client.query('SELECT 1 FROM qase_cells LIMIT 1'); return true; });
		},
		close() { closing ??= Promise.resolve(pool.end()); return closing; }
	});
}
