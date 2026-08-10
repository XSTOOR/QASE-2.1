const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class DrytisTokenReplayError extends Error {
	constructor() {
		super('This Drytis launch token has already been exchanged.');
		this.name = 'DrytisTokenReplayError';
		this.code = 'QASE_DRYTIS_TOKEN_REPLAY';
	}
}

async function scope(client, organizationId, projectId) {
	await client.query(
		"SELECT set_config('qase.organization_id', $1, true), set_config('qase.project_id', $2, true)",
		[organizationId, projectId]
	);
}

function requireUuid(value, label) {
	if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new TypeError(`${label} must be a canonical UUID.`);
	return value.toLowerCase();
}

/** Shared PostgreSQL identity/session store used by every API replica in one Qase cell. */
export function createPostgresIdentityRepository({ pool }) {
	if (!pool || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required.');

	async function transaction(organizationId, projectId, work) {
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await scope(client, organizationId, projectId);
			const result = await work(client);
			await client.query('COMMIT');
			return result;
		} catch (error) {
			await client.query('ROLLBACK').catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}

	return Object.freeze({
		async exchange(claims, session) {
			const organizationId = requireUuid(claims.organizationId, 'organizationId');
			const projectId = requireUuid(claims.projectId, 'projectId');
			const userId = requireUuid(claims.actorUserId, 'actorUserId');
			return transaction(organizationId, projectId, async client => {
				await client.query(
					`DELETE FROM drytis_token_exchanges
					 WHERE organization_id = $1 AND project_id = $2 AND expires_at < CURRENT_TIMESTAMP`,
					[organizationId, projectId]
				);
				await client.query(
					`DELETE FROM qase_auth_sessions
					 WHERE organization_id = $1 AND project_id = $2
					 AND (expires_at < CURRENT_TIMESTAMP OR revoked_at < CURRENT_TIMESTAMP - INTERVAL '7 days')`,
					[organizationId, projectId]
				);
				const organization = await client.query(
					`INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)
					 ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name, updated_at = CURRENT_TIMESTAMP
					 WHERE organizations.status = 'active' RETURNING id`,
					[organizationId, claims.organizationSlug, claims.organizationName]
				);
				if (organization.rowCount !== 1) throw new Error('Drytis organization is not active.');
				await client.query(
					`INSERT INTO users (id, email, normalized_email, display_name) VALUES ($1, $2, $3, $4)
					 ON CONFLICT DO NOTHING`,
					[userId, claims.email, claims.email, claims.displayName]
				);
				await client.query(
					`INSERT INTO organization_memberships (organization_id, user_id, role, created_by_user_id)
					 VALUES ($1, $2, $3, $2)
					 ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = CURRENT_TIMESTAMP
					 WHERE organization_memberships.status = 'active'`,
					[organizationId, userId, claims.role]
				);
				const user = await client.query(
					`UPDATE users SET email = $2, normalized_email = $2, display_name = $3, updated_at = CURRENT_TIMESTAMP
					 WHERE id = $1 AND status = 'active' RETURNING id`,
					[userId, claims.email, claims.displayName]
				);
				if (user.rowCount !== 1) throw new Error('Drytis user is not active or conflicts with another identity.');
				const project = await client.query(
					`INSERT INTO projects (id, organization_id, slug, name, created_by_user_id) VALUES ($1, $2, $3, $4, $5)
					 ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name, updated_at = CURRENT_TIMESTAMP
					 WHERE projects.organization_id = EXCLUDED.organization_id AND projects.status = 'active' RETURNING id`,
					[projectId, organizationId, claims.projectSlug, claims.projectName, userId]
				);
				if (project.rowCount !== 1) throw new Error('Drytis project is not active or belongs to another organization.');
				const identity = await client.query(
					`INSERT INTO drytis_identities (issuer, subject, organization_id, user_id) VALUES ($1, $2, $3, $4)
					 ON CONFLICT (issuer, subject, organization_id) DO UPDATE SET last_login_at = CURRENT_TIMESTAMP
					 WHERE drytis_identities.user_id = EXCLUDED.user_id RETURNING user_id`,
					[claims.issuer, claims.subject, organizationId, userId]
				);
				if (identity.rowCount !== 1) throw new Error('Drytis identity is already bound to a different Qase user.');
				try {
					await client.query(
						`INSERT INTO drytis_token_exchanges
						 (issuer, jti, organization_id, project_id, user_id, expires_at)
						 VALUES ($1, $2, $3, $4, $5, $6)`,
						[claims.issuer, claims.jti, organizationId, projectId, userId, new Date(claims.expiresAt * 1000)]
					);
				} catch (error) {
					if (error?.code === '23505') throw new DrytisTokenReplayError();
					throw error;
				}
				await client.query(
					`INSERT INTO qase_auth_sessions
					 (id, organization_id, project_id, user_id, token_hash, expires_at)
					 VALUES ($1, $2, $3, $4, $5, $6)`,
					[session.id, organizationId, projectId, userId, session.tokenHash, new Date(session.expiresAt)]
				);
				return { ...claims, sessionId: session.id, sessionExpiresAt: session.expiresAt };
			});
		},

		async resolve({ organizationId, projectId, tokenHash }) {
			requireUuid(organizationId, 'organizationId');
			requireUuid(projectId, 'projectId');
			return transaction(organizationId, projectId, async client => {
				const result = await client.query(
					`SELECT session.id, session.organization_id, session.project_id, session.user_id,
					 session.expires_at, users.email, users.display_name, membership.role
					 FROM qase_auth_sessions session
					 JOIN users ON users.id = session.user_id AND users.status = 'active'
					 JOIN organization_memberships membership ON membership.organization_id = session.organization_id
					  AND membership.user_id = session.user_id AND membership.status = 'active'
					 JOIN organizations organization ON organization.id = session.organization_id AND organization.status = 'active'
					 JOIN projects project ON project.organization_id = session.organization_id
					  AND project.id = session.project_id AND project.status = 'active'
					 WHERE session.organization_id = $1 AND session.project_id = $2 AND session.token_hash = $3
					  AND session.revoked_at IS NULL AND session.expires_at > CURRENT_TIMESTAMP`,
					[organizationId, projectId, tokenHash]
				);
				const row = result.rows[0];
				return row ? {
					sessionId: row.id, organizationId: row.organization_id, projectId: row.project_id,
					actorUserId: row.user_id, email: row.email, displayName: row.display_name,
					role: row.role, expiresAt: new Date(row.expires_at).getTime()
				} : undefined;
			});
		},

		async revoke({ organizationId, projectId, tokenHash }) {
			return transaction(organizationId, projectId, async client => {
				const result = await client.query(
					`UPDATE qase_auth_sessions SET revoked_at = CURRENT_TIMESTAMP
					 WHERE organization_id = $1 AND project_id = $2 AND token_hash = $3 AND revoked_at IS NULL`,
					[organizationId, projectId, tokenHash]
				);
				return result.rowCount === 1;
			});
		}
	});
}
