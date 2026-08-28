-- Qase PostgreSQL migration 010: Drytis product-integration metadata.
--
-- Raw source code is intentionally absent. The run document stores only the
-- bounded, derived white-box analysis, immutable source digests, correlation
-- identifiers, and idempotency metadata needed to return results to Drytis.

ALTER TABLE qa_runs
	ADD COLUMN drytis_integration jsonb,
	ADD CONSTRAINT qa_runs_drytis_integration_object
		CHECK (
			drytis_integration IS NULL
			OR (
				jsonb_typeof(drytis_integration) = 'object'
				AND pg_column_size(drytis_integration) <= 1048576
			)
		),
	ADD CONSTRAINT qa_runs_drytis_integration_mode
		CHECK (drytis_integration IS NULL OR run_mode = 'qa');

-- Execution jobs created by the signed Drytis service are system work, not
-- actions authored by the bootstrap human user. Existing jobs remain `user`
-- actors; service/system jobs deliberately have no user foreign key.
ALTER TABLE qa_execution_jobs
	ALTER COLUMN requested_by_user_id DROP NOT NULL,
	ADD COLUMN requested_by_actor_type text NOT NULL DEFAULT 'user',
	ADD CONSTRAINT qa_execution_jobs_request_actor_shape CHECK (
		(requested_by_actor_type = 'user' AND requested_by_user_id IS NOT NULL)
		OR (requested_by_actor_type IN ('system', 'service') AND requested_by_user_id IS NULL)
	);

-- Signed-request nonces are a transport replay fence. Business idempotency is
-- independently attached to the integration run because the same operation
-- may be retried with a fresh signed nonce after a network failure.
CREATE TABLE qase_drytis_request_nonces (
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	nonce_sha256 text NOT NULL,
	expires_at timestamptz NOT NULL,
	received_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (organization_id, project_id, nonce_sha256),
	CONSTRAINT qase_drytis_request_nonces_project_fk
		FOREIGN KEY (organization_id, project_id)
		REFERENCES projects (organization_id, id) ON DELETE CASCADE,
	CONSTRAINT qase_drytis_request_nonces_digest
		CHECK (nonce_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT qase_drytis_request_nonces_window
		CHECK (expires_at > received_at AND expires_at <= received_at + INTERVAL '1 hour')
);

CREATE INDEX qase_drytis_request_nonces_expiry
	ON qase_drytis_request_nonces (organization_id, project_id, expires_at);

ALTER TABLE qase_drytis_request_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE qase_drytis_request_nonces FORCE ROW LEVEL SECURITY;
CREATE POLICY qase_drytis_request_nonces_tenant_scope
	ON qase_drytis_request_nonces FOR ALL
	USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	)
	WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);
