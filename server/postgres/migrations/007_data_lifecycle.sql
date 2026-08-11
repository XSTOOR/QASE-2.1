-- Qase PostgreSQL migration 007: tenant-safe data lifecycle governance.
--
-- This migration is intentionally additive. It introduces the durable control
-- records needed for two-stage deletion, legal holds, erasure audit, and
-- restore suppression without enabling any automatic destructive behavior.

CREATE TABLE qase_lifecycle_requests (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	subject_type text NOT NULL,
	subject_id uuid NOT NULL,
	action text NOT NULL,
	status text NOT NULL DEFAULT 'requested',
	idempotency_key text NOT NULL,
	requested_by_actor_type text NOT NULL DEFAULT 'user',
	requested_by_user_id uuid,
	reason_code text,
	reference_id text,
	policy_version text NOT NULL,
	purge_after timestamptz NOT NULL,
	available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	attempts integer NOT NULL DEFAULT 0,
	lease_owner text,
	lease_token uuid,
	lease_expires_at timestamptz,
	started_at timestamptz,
	finished_at timestamptz,
	correlation_id uuid,
	last_error_code text,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT qase_lifecycle_requests_subject_type_valid CHECK (subject_type IN ('run', 'project')),
	CONSTRAINT qase_lifecycle_requests_project_subject_consistent CHECK (
		subject_type <> 'project' OR subject_id = project_id
	),
	CONSTRAINT qase_lifecycle_requests_action_valid CHECK (action IN ('soft_delete', 'purge', 'erase')),
	CONSTRAINT qase_lifecycle_requests_status_valid CHECK (
		status IN ('requested', 'approved', 'processing', 'held', 'completed', 'failed', 'cancelled')
	),
	CONSTRAINT qase_lifecycle_requests_idempotency_key_present CHECK (
		char_length(btrim(idempotency_key)) BETWEEN 1 AND 200
	),
	CONSTRAINT qase_lifecycle_requests_actor_type_valid CHECK (
		requested_by_actor_type IN ('user', 'system', 'worker')
	),
	CONSTRAINT qase_lifecycle_requests_actor_consistent CHECK (
		(requested_by_actor_type = 'user' AND requested_by_user_id IS NOT NULL)
		OR (requested_by_actor_type <> 'user' AND requested_by_user_id IS NULL)
	),
	CONSTRAINT qase_lifecycle_requests_reason_code_size CHECK (
		reason_code IS NULL OR char_length(btrim(reason_code)) BETWEEN 1 AND 100
	),
	CONSTRAINT qase_lifecycle_requests_reference_id_size CHECK (
		reference_id IS NULL OR char_length(btrim(reference_id)) BETWEEN 1 AND 200
	),
	CONSTRAINT qase_lifecycle_requests_policy_version_present CHECK (
		char_length(btrim(policy_version)) BETWEEN 1 AND 64
	),
	CONSTRAINT qase_lifecycle_requests_purge_window_valid CHECK (purge_after >= created_at),
	CONSTRAINT qase_lifecycle_requests_attempts_valid CHECK (attempts BETWEEN 0 AND 100),
	CONSTRAINT qase_lifecycle_requests_lease_owner_size CHECK (
		lease_owner IS NULL OR char_length(btrim(lease_owner)) BETWEEN 1 AND 200
	),
	CONSTRAINT qase_lifecycle_requests_lease_shape CHECK (
		(status = 'processing' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
		OR (status <> 'processing' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
	),
	CONSTRAINT qase_lifecycle_requests_finished_shape CHECK (
		(status IN ('completed', 'cancelled') AND finished_at IS NOT NULL)
		OR (status NOT IN ('completed', 'cancelled') AND finished_at IS NULL)
	),
	CONSTRAINT qase_lifecycle_requests_error_code_size CHECK (
		last_error_code IS NULL OR char_length(btrim(last_error_code)) BETWEEN 1 AND 100
	),
	CONSTRAINT qase_lifecycle_requests_idempotency_unique UNIQUE (
		organization_id,
		project_id,
		action,
		subject_type,
		subject_id,
		idempotency_key
	)
);

CREATE INDEX qase_lifecycle_requests_claim
	ON qase_lifecycle_requests (
		organization_id,
		project_id,
		available_at,
		purge_after,
		created_at,
		id
	)
	WHERE status = 'approved';

CREATE INDEX qase_lifecycle_requests_expired_lease
	ON qase_lifecycle_requests (organization_id, project_id, lease_expires_at, id)
	WHERE status = 'processing';

CREATE INDEX qase_lifecycle_requests_subject_lookup
	ON qase_lifecycle_requests (
		organization_id,
		project_id,
		subject_type,
		subject_id,
		created_at DESC,
		id
	);

CREATE FUNCTION qase_validate_lifecycle_request_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'lifecycle requests cannot be deleted'
			USING ERRCODE = '55000';
	END IF;

	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'requested'
			OR NEW.attempts <> 0
			OR NEW.started_at IS NOT NULL
			OR NEW.finished_at IS NOT NULL
			OR NEW.lease_owner IS NOT NULL
			OR NEW.lease_token IS NOT NULL
			OR NEW.lease_expires_at IS NOT NULL THEN
			RAISE EXCEPTION 'new lifecycle requests must start in the requested state'
				USING ERRCODE = '22023';
		END IF;
		RETURN NEW;
	END IF;

	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
		OR NEW.project_id IS DISTINCT FROM OLD.project_id
		OR NEW.subject_type IS DISTINCT FROM OLD.subject_type
		OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
		OR NEW.action IS DISTINCT FROM OLD.action
		OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
		OR NEW.requested_by_actor_type IS DISTINCT FROM OLD.requested_by_actor_type
		OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
		OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
		OR NEW.reference_id IS DISTINCT FROM OLD.reference_id
		OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
		OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'lifecycle request identity and policy fields are immutable'
			USING ERRCODE = '55000';
	END IF;

	IF OLD.status IN ('completed', 'cancelled') THEN
		RAISE EXCEPTION 'terminal lifecycle requests are immutable'
			USING ERRCODE = '55000';
	END IF;

	IF NEW.purge_after < OLD.purge_after THEN
		RAISE EXCEPTION 'lifecycle purge_after may only be extended'
			USING ERRCODE = '22023';
	END IF;

	IF NEW.attempts < OLD.attempts THEN
		RAISE EXCEPTION 'lifecycle attempts cannot decrease'
			USING ERRCODE = '22023';
	END IF;

	IF NEW.status <> OLD.status AND NOT (
		(OLD.status = 'requested' AND NEW.status IN ('approved', 'held', 'cancelled'))
		OR (OLD.status = 'approved' AND NEW.status IN ('processing', 'held', 'cancelled'))
		OR (OLD.status = 'processing' AND NEW.status IN ('approved', 'completed', 'failed', 'held', 'cancelled'))
		OR (OLD.status = 'held' AND NEW.status IN ('approved', 'cancelled'))
		OR (OLD.status = 'failed' AND NEW.status IN ('approved', 'cancelled'))
	) THEN
		RAISE EXCEPTION 'invalid lifecycle request transition from % to %', OLD.status, NEW.status
			USING ERRCODE = '22023';
	END IF;

	RETURN NEW;
END;
$$;

CREATE TRIGGER qase_lifecycle_requests_state_machine
	BEFORE INSERT OR UPDATE OR DELETE ON qase_lifecycle_requests
	FOR EACH ROW EXECUTE FUNCTION qase_validate_lifecycle_request_transition();

-- This table contains only active run holds. The restrictive foreign key is an
-- independent fail-closed guard: a run cannot be physically removed until its
-- hold is explicitly released. Hold placement/release history belongs in the
-- immutable qase_lifecycle_events ledger below.
CREATE TABLE qa_run_legal_holds (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	run_id uuid NOT NULL,
	reason_code text NOT NULL,
	reference_id text NOT NULL,
	policy_version text NOT NULL,
	placed_by_actor_type text NOT NULL DEFAULT 'user',
	placed_by_user_id uuid,
	placed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	correlation_id uuid,
	CONSTRAINT qa_run_legal_holds_run_fk
		FOREIGN KEY (organization_id, project_id, run_id)
		REFERENCES qa_runs (organization_id, project_id, id) ON DELETE RESTRICT,
	CONSTRAINT qa_run_legal_holds_reason_code_present CHECK (
		char_length(btrim(reason_code)) BETWEEN 1 AND 100
	),
	CONSTRAINT qa_run_legal_holds_reference_id_present CHECK (
		char_length(btrim(reference_id)) BETWEEN 1 AND 200
	),
	CONSTRAINT qa_run_legal_holds_policy_version_present CHECK (
		char_length(btrim(policy_version)) BETWEEN 1 AND 64
	),
	CONSTRAINT qa_run_legal_holds_actor_type_valid CHECK (
		placed_by_actor_type IN ('user', 'system', 'worker')
	),
	CONSTRAINT qa_run_legal_holds_actor_consistent CHECK (
		(placed_by_actor_type = 'user' AND placed_by_user_id IS NOT NULL)
		OR (placed_by_actor_type <> 'user' AND placed_by_user_id IS NULL)
	),
	CONSTRAINT qa_run_legal_holds_reference_unique UNIQUE (
		organization_id, project_id, run_id, reference_id
	)
);

CREATE INDEX qa_run_legal_holds_placed_lookup
	ON qa_run_legal_holds (organization_id, project_id, placed_at, run_id);

CREATE FUNCTION qase_reject_legal_hold_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'active legal holds cannot be updated; release and replace the hold'
		USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER qa_run_legal_holds_no_update
	BEFORE UPDATE ON qa_run_legal_holds
	FOR EACH ROW EXECUTE FUNCTION qase_reject_legal_hold_update();

-- External credential/browser/workspace cleanup is not transactionally coupled
-- to PostgreSQL. This durable gate survives run purge and prevents retention
-- from treating a one-shot cleanup attempt as completed.
CREATE TABLE qase_run_cleanup (
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	run_id uuid NOT NULL,
	status text NOT NULL DEFAULT 'pending',
	attempts integer NOT NULL DEFAULT 0,
	requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	last_attempt_at timestamptz,
	completed_at timestamptz,
	last_error_code text,
	correlation_id uuid,
	request_reference_id text NOT NULL,
	attestation_reference_id text,
	policy_version text NOT NULL,
	PRIMARY KEY (organization_id, project_id, run_id),
	CONSTRAINT qase_run_cleanup_status_valid CHECK (status IN ('pending', 'failed', 'completed')),
	CONSTRAINT qase_run_cleanup_attempts_valid CHECK (attempts BETWEEN 0 AND 100),
	CONSTRAINT qase_run_cleanup_completed_shape CHECK (
		(status = 'completed' AND completed_at IS NOT NULL AND attestation_reference_id IS NOT NULL)
		OR (status <> 'completed' AND completed_at IS NULL AND attestation_reference_id IS NULL)
	),
	CONSTRAINT qase_run_cleanup_error_code_size CHECK (
		last_error_code IS NULL OR char_length(btrim(last_error_code)) BETWEEN 1 AND 100
	),
	CONSTRAINT qase_run_cleanup_request_reference_id_present CHECK (
		char_length(btrim(request_reference_id)) BETWEEN 1 AND 200
	),
	CONSTRAINT qase_run_cleanup_attestation_reference_id_size CHECK (
		attestation_reference_id IS NULL
		OR char_length(btrim(attestation_reference_id)) BETWEEN 1 AND 200
	),
	CONSTRAINT qase_run_cleanup_policy_version_present CHECK (
		char_length(btrim(policy_version)) BETWEEN 1 AND 64
	)
);

CREATE INDEX qase_run_cleanup_pending
	ON qase_run_cleanup (organization_id, project_id, status, requested_at, run_id)
	WHERE status <> 'completed';

CREATE FUNCTION qase_validate_run_cleanup_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'run cleanup records cannot be deleted'
			USING ERRCODE = '55000';
	END IF;
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'pending' OR NEW.attempts <> 0
			OR NEW.last_attempt_at IS NOT NULL OR NEW.completed_at IS NOT NULL
			OR NEW.last_error_code IS NOT NULL OR NEW.attestation_reference_id IS NOT NULL THEN
			RAISE EXCEPTION 'new run cleanup records must start pending'
				USING ERRCODE = '22023';
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
		OR NEW.project_id IS DISTINCT FROM OLD.project_id
		OR NEW.run_id IS DISTINCT FROM OLD.run_id
		OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
		OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
		OR NEW.request_reference_id IS DISTINCT FROM OLD.request_reference_id
		OR NEW.policy_version IS DISTINCT FROM OLD.policy_version THEN
		RAISE EXCEPTION 'run cleanup identity and policy fields are immutable'
			USING ERRCODE = '55000';
	END IF;
	IF OLD.status = 'completed' THEN
		RAISE EXCEPTION 'completed run cleanup records are immutable'
			USING ERRCODE = '55000';
	END IF;
	IF NEW.attestation_reference_id IS DISTINCT FROM OLD.attestation_reference_id AND NOT (
		OLD.attestation_reference_id IS NULL
		AND NEW.attestation_reference_id IS NOT NULL
		AND OLD.status IN ('pending', 'failed')
		AND NEW.status = 'completed'
	) THEN
		RAISE EXCEPTION 'cleanup attestation reference may only be set on completion'
			USING ERRCODE = '55000';
	END IF;
	IF NEW.attempts <= OLD.attempts THEN
		RAISE EXCEPTION 'run cleanup attempts must increase'
			USING ERRCODE = '22023';
	END IF;
	RETURN NEW;
END;
$$;

CREATE TRIGGER qase_run_cleanup_state_machine
	BEFORE INSERT OR UPDATE OR DELETE ON qase_run_cleanup
	FOR EACH ROW EXECUTE FUNCTION qase_validate_run_cleanup_transition();

-- The lifecycle ledger deliberately has no foreign key to requests, runs, or
-- projects. Its minimal, non-content metadata therefore survives an approved
-- purge and can prove what policy-controlled action occurred.
CREATE TABLE qase_lifecycle_events (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	request_id uuid,
	subject_type text NOT NULL,
	subject_id uuid NOT NULL,
	action text NOT NULL,
	event_type text NOT NULL,
	from_status text,
	to_status text,
	actor_type text NOT NULL DEFAULT 'system',
	actor_user_id uuid,
	reason_code text,
	reference_id text,
	resource_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
	manifest_sha256 char(64),
	correlation_id uuid,
	policy_version text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT qase_lifecycle_events_subject_type_valid CHECK (subject_type IN ('run', 'project')),
	CONSTRAINT qase_lifecycle_events_project_subject_consistent CHECK (
		subject_type <> 'project' OR subject_id = project_id
	),
	CONSTRAINT qase_lifecycle_events_action_present CHECK (
		char_length(btrim(action)) BETWEEN 1 AND 100
	),
	CONSTRAINT qase_lifecycle_events_event_type_present CHECK (
		char_length(btrim(event_type)) BETWEEN 1 AND 160
	),
	CONSTRAINT qase_lifecycle_events_from_status_valid CHECK (
		from_status IS NULL OR from_status IN (
			'requested', 'approved', 'processing', 'held', 'completed', 'failed', 'cancelled'
		)
	),
	CONSTRAINT qase_lifecycle_events_to_status_valid CHECK (
		to_status IS NULL OR to_status IN (
			'requested', 'approved', 'processing', 'held', 'completed', 'failed', 'cancelled'
		)
	),
	CONSTRAINT qase_lifecycle_events_actor_type_valid CHECK (actor_type IN ('user', 'system', 'worker')),
	CONSTRAINT qase_lifecycle_events_actor_consistent CHECK (
		(actor_type = 'user' AND actor_user_id IS NOT NULL)
		OR (actor_type <> 'user' AND actor_user_id IS NULL)
	),
	CONSTRAINT qase_lifecycle_events_reason_code_size CHECK (
		reason_code IS NULL OR char_length(btrim(reason_code)) BETWEEN 1 AND 100
	),
	CONSTRAINT qase_lifecycle_events_reference_id_size CHECK (
		reference_id IS NULL OR char_length(btrim(reference_id)) BETWEEN 1 AND 200
	),
	CONSTRAINT qase_lifecycle_events_resource_counts_object CHECK (jsonb_typeof(resource_counts) = 'object'),
	CONSTRAINT qase_lifecycle_events_manifest_sha256_valid CHECK (
		manifest_sha256 IS NULL OR manifest_sha256 ~ '^[0-9a-f]{64}$'
	),
	CONSTRAINT qase_lifecycle_events_policy_version_present CHECK (
		char_length(btrim(policy_version)) BETWEEN 1 AND 64
	)
);

CREATE INDEX qase_lifecycle_events_request_history
	ON qase_lifecycle_events (organization_id, project_id, request_id, created_at, id)
	WHERE request_id IS NOT NULL;

CREATE INDEX qase_lifecycle_events_subject_history
	ON qase_lifecycle_events (
		organization_id,
		project_id,
		subject_type,
		subject_id,
		created_at,
		id
	);

CREATE FUNCTION qase_reject_immutable_lifecycle_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
		USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER qase_lifecycle_events_append_only
	BEFORE UPDATE OR DELETE ON qase_lifecycle_events
	FOR EACH ROW EXECUTE FUNCTION qase_reject_immutable_lifecycle_row_mutation();

-- Tombstones contain no source content. They suppress accidental restoration or
-- re-import of a subject that completed an erasure workflow.
CREATE TABLE qase_erasure_tombstones (
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	subject_type text NOT NULL,
	subject_id uuid NOT NULL,
	lifecycle_request_id uuid,
	erased_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	reason_code text,
	reference_id text,
	manifest_sha256 char(64),
	policy_version text NOT NULL,
	correlation_id uuid,
	PRIMARY KEY (organization_id, project_id, subject_type, subject_id),
	CONSTRAINT qase_erasure_tombstones_subject_type_valid CHECK (subject_type IN ('run', 'project')),
	CONSTRAINT qase_erasure_tombstones_project_subject_consistent CHECK (
		subject_type <> 'project' OR subject_id = project_id
	),
	CONSTRAINT qase_erasure_tombstones_reason_code_size CHECK (
		reason_code IS NULL OR char_length(btrim(reason_code)) BETWEEN 1 AND 100
	),
	CONSTRAINT qase_erasure_tombstones_reference_id_size CHECK (
		reference_id IS NULL OR char_length(btrim(reference_id)) BETWEEN 1 AND 200
	),
	CONSTRAINT qase_erasure_tombstones_manifest_sha256_valid CHECK (
		manifest_sha256 IS NULL OR manifest_sha256 ~ '^[0-9a-f]{64}$'
	),
	CONSTRAINT qase_erasure_tombstones_policy_version_present CHECK (
		char_length(btrim(policy_version)) BETWEEN 1 AND 64
	)
);

CREATE INDEX qase_erasure_tombstones_erased_lookup
	ON qase_erasure_tombstones (organization_id, project_id, erased_at, subject_type, subject_id);

CREATE TRIGGER qase_erasure_tombstones_append_only
	BEFORE UPDATE OR DELETE ON qase_erasure_tombstones
	FOR EACH ROW EXECUTE FUNCTION qase_reject_immutable_lifecycle_row_mutation();

CREATE FUNCTION qase_block_erased_run_restore()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM qase_erasure_tombstones tombstone
		WHERE tombstone.organization_id = NEW.organization_id
			AND tombstone.project_id = NEW.project_id
			AND tombstone.subject_type = 'run'
			AND tombstone.subject_id = NEW.id
	) THEN
		RAISE EXCEPTION 'run identifier is suppressed by an erasure tombstone'
			USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;

CREATE TRIGGER qa_runs_restore_suppression
	BEFORE INSERT ON qa_runs
	FOR EACH ROW EXECUTE FUNCTION qase_block_erased_run_restore();

-- Every lifecycle table is forced through explicit tenant and project context.
-- Missing settings evaluate to NULL and therefore match no rows (default deny).
ALTER TABLE qase_lifecycle_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE qase_lifecycle_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY qase_lifecycle_requests_select_tenant_scope ON qase_lifecycle_requests
	FOR SELECT USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);
CREATE POLICY qase_lifecycle_requests_insert_tenant_scope ON qase_lifecycle_requests
	FOR INSERT WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);
CREATE POLICY qase_lifecycle_requests_update_tenant_scope ON qase_lifecycle_requests
	FOR UPDATE
	USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	)
	WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);

ALTER TABLE qa_run_legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE qa_run_legal_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY qa_run_legal_holds_tenant_scope ON qa_run_legal_holds
	FOR ALL
	USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	)
	WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);

ALTER TABLE qase_run_cleanup ENABLE ROW LEVEL SECURITY;
ALTER TABLE qase_run_cleanup FORCE ROW LEVEL SECURITY;
CREATE POLICY qase_run_cleanup_select_tenant_scope ON qase_run_cleanup
	FOR SELECT USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);
CREATE POLICY qase_run_cleanup_insert_tenant_scope ON qase_run_cleanup
	FOR INSERT WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);
CREATE POLICY qase_run_cleanup_update_tenant_scope ON qase_run_cleanup
	FOR UPDATE
	USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	)
	WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);

ALTER TABLE qase_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE qase_lifecycle_events FORCE ROW LEVEL SECURITY;
CREATE POLICY qase_lifecycle_events_select_tenant_scope ON qase_lifecycle_events
	FOR SELECT USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);
CREATE POLICY qase_lifecycle_events_insert_tenant_scope ON qase_lifecycle_events
	FOR INSERT WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);

ALTER TABLE qase_erasure_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE qase_erasure_tombstones FORCE ROW LEVEL SECURITY;
CREATE POLICY qase_erasure_tombstones_select_tenant_scope ON qase_erasure_tombstones
	FOR SELECT USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);
CREATE POLICY qase_erasure_tombstones_insert_tenant_scope ON qase_erasure_tombstones
	FOR INSERT WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);

-- Stable, tenant-first ordering keeps each purge transaction explicitly bounded
-- by a LIMIT in the worker while avoiding scans of active rows.
-- Migration 003's original global source digest uniqueness could couple two
-- tenants importing the same export. Scope idempotency to the project instead.
ALTER TABLE qa_legacy_imports DROP CONSTRAINT qa_legacy_imports_source_unique;
ALTER TABLE qa_legacy_imports ADD CONSTRAINT qa_legacy_imports_source_unique
	UNIQUE (organization_id, project_id, source_kind, source_sha256);

CREATE INDEX qa_runs_purge_candidates
	ON qa_runs (organization_id, project_id, deleted_at, id)
	WHERE deleted_at IS NOT NULL;

CREATE INDEX qase_auth_sessions_purge_candidates
	ON qase_auth_sessions (organization_id, project_id, expires_at, id);

CREATE INDEX qase_auth_sessions_revoked_purge_candidates
	ON qase_auth_sessions (organization_id, project_id, revoked_at, id)
	WHERE revoked_at IS NOT NULL;

CREATE INDEX drytis_token_exchanges_purge_candidates
	ON drytis_token_exchanges (organization_id, project_id, expires_at, issuer, jti);

CREATE INDEX qa_execution_jobs_purge_candidates
	ON qa_execution_jobs (organization_id, project_id, finished_at, id)
	WHERE status IN ('succeeded', 'failed', 'cancelled') AND finished_at IS NOT NULL;
