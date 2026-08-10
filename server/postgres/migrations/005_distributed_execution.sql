-- Qase PostgreSQL migration 005: durable distributed execution jobs and leases.

CREATE TABLE qa_execution_jobs (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	run_id uuid NOT NULL,
	requested_by_user_id uuid NOT NULL,
	kind text NOT NULL,
	payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	status text NOT NULL DEFAULT 'queued',
	attempts integer NOT NULL DEFAULT 0,
	max_attempts integer NOT NULL DEFAULT 3,
	available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	lease_owner text,
	lease_token uuid,
	lease_expires_at timestamptz,
	last_heartbeat_at timestamptz,
	started_at timestamptz,
	finished_at timestamptz,
	error_code text,
	error_detail text,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT qa_execution_jobs_run_fk FOREIGN KEY (organization_id, project_id, run_id)
		REFERENCES qa_runs (organization_id, project_id, id) ON DELETE CASCADE,
	CONSTRAINT qa_execution_jobs_requester_fk FOREIGN KEY (organization_id, requested_by_user_id)
		REFERENCES organization_memberships (organization_id, user_id) ON DELETE RESTRICT,
	CONSTRAINT qa_execution_jobs_kind_valid CHECK (kind IN ('turn')),
	CONSTRAINT qa_execution_jobs_status_valid CHECK (
		status IN ('queued', 'leased', 'cancel_requested', 'succeeded', 'failed', 'cancelled')
	),
	CONSTRAINT qa_execution_jobs_attempts_valid CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 20),
	CONSTRAINT qa_execution_jobs_payload_object CHECK (jsonb_typeof(payload) = 'object'),
	CONSTRAINT qa_execution_jobs_error_detail_size CHECK (error_detail IS NULL OR char_length(error_detail) <= 2000),
	CONSTRAINT qa_execution_jobs_lease_shape CHECK (
		(status IN ('leased', 'cancel_requested') AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
		OR (status NOT IN ('leased', 'cancel_requested'))
	)
);

CREATE UNIQUE INDEX qa_execution_jobs_one_active_per_run
	ON qa_execution_jobs (organization_id, project_id, run_id)
	WHERE status IN ('queued', 'leased', 'cancel_requested');

CREATE INDEX qa_execution_jobs_claim
	ON qa_execution_jobs (organization_id, project_id, available_at, created_at, id)
	WHERE status = 'queued';

CREATE INDEX qa_execution_jobs_expired_lease
	ON qa_execution_jobs (organization_id, project_id, lease_expires_at)
	WHERE status IN ('leased', 'cancel_requested');

ALTER TABLE qa_execution_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE qa_execution_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY qa_execution_jobs_tenant_scope ON qa_execution_jobs FOR ALL
	USING (organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid)
	WITH CHECK (organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid);
