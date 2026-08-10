-- Qase PostgreSQL migration 003: durable run events, legacy import ledger, and tenant RLS.

CREATE TABLE qa_run_events (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	run_id uuid NOT NULL,
	sequence bigint NOT NULL,
	event_type text NOT NULL,
	payload_version smallint NOT NULL DEFAULT 1,
	payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	actor_type text NOT NULL DEFAULT 'system',
	actor_user_id uuid,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT qa_run_events_run_fk
		FOREIGN KEY (organization_id, project_id, run_id)
		REFERENCES qa_runs (organization_id, project_id, id) ON DELETE CASCADE,
	CONSTRAINT qa_run_events_actor_fk
		FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL,
	CONSTRAINT qa_run_events_sequence_positive CHECK (sequence > 0),
	CONSTRAINT qa_run_events_type_present CHECK (char_length(btrim(event_type)) BETWEEN 1 AND 200),
	CONSTRAINT qa_run_events_payload_version_positive CHECK (payload_version > 0),
	CONSTRAINT qa_run_events_payload_object CHECK (jsonb_typeof(payload) = 'object'),
	CONSTRAINT qa_run_events_actor_type_valid CHECK (actor_type IN ('user', 'agent', 'system')),
	CONSTRAINT qa_run_events_actor_consistent CHECK (
		(actor_type = 'user' AND actor_user_id IS NOT NULL)
		OR (actor_type <> 'user' AND actor_user_id IS NULL)
	),
	CONSTRAINT qa_run_events_run_sequence_unique UNIQUE (organization_id, project_id, run_id, sequence)
);

CREATE INDEX qa_run_events_run_order
	ON qa_run_events (organization_id, project_id, run_id, sequence);

CREATE TABLE qa_legacy_imports (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	imported_by_user_id uuid,
	source_kind text NOT NULL DEFAULT 'sessions_json',
	source_sha256 text NOT NULL,
	source_label text,
	counts jsonb NOT NULL DEFAULT '{}'::jsonb,
	imported_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT qa_legacy_imports_project_fk
		FOREIGN KEY (organization_id, project_id)
		REFERENCES projects (organization_id, id) ON DELETE RESTRICT,
	CONSTRAINT qa_legacy_imports_user_fk
		FOREIGN KEY (imported_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
	CONSTRAINT qa_legacy_imports_source_kind_present CHECK (char_length(btrim(source_kind)) BETWEEN 1 AND 100),
	CONSTRAINT qa_legacy_imports_sha256_valid CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT qa_legacy_imports_counts_object CHECK (jsonb_typeof(counts) = 'object'),
	CONSTRAINT qa_legacy_imports_source_unique UNIQUE (source_kind, source_sha256)
);

-- The application must set both values with transaction-local set_config calls.
-- NULL/missing settings make every tenant predicate false (default deny).
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organizations_tenant_scope ON organizations
	FOR ALL
	USING (id = NULLIF(current_setting('qase.organization_id', true), '')::uuid)
	WITH CHECK (id = NULLIF(current_setting('qase.organization_id', true), '')::uuid);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_select_tenant_scope ON users
	FOR SELECT
	USING (EXISTS (
		SELECT 1
		FROM organization_memberships membership
		WHERE membership.organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
			AND membership.user_id = users.id
			AND membership.status = 'active'
	));
CREATE POLICY users_insert_tenant_scope ON users
	FOR INSERT
	WITH CHECK (
		NULLIF(current_setting('qase.organization_id', true), '')::uuid IS NOT NULL
		AND NULLIF(current_setting('qase.project_id', true), '')::uuid IS NOT NULL
	);
CREATE POLICY users_update_tenant_scope ON users
	FOR UPDATE
	USING (EXISTS (
		SELECT 1 FROM organization_memberships membership
		WHERE membership.organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
			AND membership.user_id = users.id
			AND membership.status = 'active'
	))
	WITH CHECK (EXISTS (
		SELECT 1 FROM organization_memberships membership
		WHERE membership.organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
			AND membership.user_id = users.id
			AND membership.status = 'active'
	));

ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_memberships_tenant_scope ON organization_memberships
	FOR ALL
	USING (organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid)
	WITH CHECK (organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
CREATE POLICY projects_tenant_scope ON projects
	FOR ALL
	USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	)
	WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);

ALTER TABLE qa_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE qa_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY qa_runs_tenant_scope ON qa_runs
	FOR ALL
	USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	)
	WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);

ALTER TABLE qa_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE qa_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY qa_messages_tenant_scope ON qa_messages
	FOR ALL
	USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	)
	WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);

ALTER TABLE qa_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE qa_activities FORCE ROW LEVEL SECURITY;
CREATE POLICY qa_activities_tenant_scope ON qa_activities
	FOR ALL
	USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	)
	WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);

ALTER TABLE qa_plan_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE qa_plan_items FORCE ROW LEVEL SECURITY;
CREATE POLICY qa_plan_items_tenant_scope ON qa_plan_items
	FOR ALL
	USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	)
	WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);

ALTER TABLE qa_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE qa_findings FORCE ROW LEVEL SECURITY;
CREATE POLICY qa_findings_tenant_scope ON qa_findings
	FOR ALL
	USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	)
	WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);

ALTER TABLE qa_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE qa_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY qa_reports_tenant_scope ON qa_reports
	FOR ALL
	USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	)
	WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);

ALTER TABLE qa_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE qa_run_events FORCE ROW LEVEL SECURITY;
CREATE POLICY qa_run_events_tenant_scope ON qa_run_events
	FOR ALL
	USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	)
	WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);

ALTER TABLE qa_legacy_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE qa_legacy_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY qa_legacy_imports_tenant_scope ON qa_legacy_imports
	FOR ALL
	USING (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	)
	WITH CHECK (
		organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
		AND project_id = NULLIF(current_setting('qase.project_id', true), '')::uuid
	);
