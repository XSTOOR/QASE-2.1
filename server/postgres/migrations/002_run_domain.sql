-- Qase PostgreSQL migration 002: durable QA run domain.

CREATE TABLE qa_runs (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	created_by_user_id uuid,
	title text NOT NULL DEFAULT 'New test run',
	target_url text,
	status text NOT NULL DEFAULT 'idle',
	status_detail text,
	pending_question jsonb,
	context_usage jsonb,
	secret_names text[] NOT NULL DEFAULT ARRAY[]::text[],
	message_count bigint NOT NULL DEFAULT 0,
	finding_count bigint NOT NULL DEFAULT 0,
	lock_version bigint NOT NULL DEFAULT 0,
	next_event_sequence bigint NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	started_at timestamptz,
	completed_at timestamptz,
	deleted_at timestamptz,
	deleted_by_user_id uuid,
	CONSTRAINT qa_runs_project_fk
		FOREIGN KEY (organization_id, project_id)
		REFERENCES projects (organization_id, id) ON DELETE RESTRICT,
	CONSTRAINT qa_runs_creator_fk
		FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
	CONSTRAINT qa_runs_deleter_fk
		FOREIGN KEY (deleted_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
	CONSTRAINT qa_runs_title_present CHECK (char_length(btrim(title)) BETWEEN 1 AND 500),
	CONSTRAINT qa_runs_target_url_size CHECK (target_url IS NULL OR char_length(target_url) <= 8192),
	CONSTRAINT qa_runs_status_valid CHECK (status IN ('idle', 'running', 'awaiting_input', 'done', 'error', 'interrupted')),
	CONSTRAINT qa_runs_pending_question_object CHECK (pending_question IS NULL OR jsonb_typeof(pending_question) = 'object'),
	CONSTRAINT qa_runs_context_usage_object CHECK (context_usage IS NULL OR jsonb_typeof(context_usage) = 'object'),
	CONSTRAINT qa_runs_nonnegative_counts CHECK (message_count >= 0 AND finding_count >= 0),
	CONSTRAINT qa_runs_secret_names_valid CHECK (array_position(secret_names, NULL) IS NULL),
	CONSTRAINT qa_runs_nonnegative_versions CHECK (lock_version >= 0 AND next_event_sequence >= 0),
	CONSTRAINT qa_runs_organization_project_id_unique UNIQUE (organization_id, project_id, id)
);

CREATE INDEX qa_runs_project_recent
	ON qa_runs (organization_id, project_id, updated_at DESC, id)
	WHERE deleted_at IS NULL;

CREATE INDEX qa_runs_project_status
	ON qa_runs (organization_id, project_id, status, updated_at DESC)
	WHERE deleted_at IS NULL;

CREATE TABLE qa_messages (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	run_id uuid NOT NULL,
	ordinal bigint NOT NULL,
	role text NOT NULL,
	kind text,
	content text NOT NULL DEFAULT '',
	actor_user_id uuid,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	completed_at timestamptz,
	CONSTRAINT qa_messages_run_fk
		FOREIGN KEY (organization_id, project_id, run_id)
		REFERENCES qa_runs (organization_id, project_id, id) ON DELETE CASCADE,
	CONSTRAINT qa_messages_actor_fk
		FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL,
	CONSTRAINT qa_messages_ordinal_positive CHECK (ordinal > 0),
	CONSTRAINT qa_messages_role_valid CHECK (role IN ('user', 'agent', 'system')),
	CONSTRAINT qa_messages_kind_size CHECK (kind IS NULL OR char_length(kind) <= 100),
	CONSTRAINT qa_messages_run_ordinal_unique UNIQUE (organization_id, project_id, run_id, ordinal)
);

CREATE INDEX qa_messages_run_order
	ON qa_messages (organization_id, project_id, run_id, ordinal);

CREATE TABLE qa_activities (
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	run_id uuid NOT NULL,
	id text NOT NULL,
	ordinal bigint NOT NULL,
	type text NOT NULL DEFAULT 'tool',
	tool_name text,
	label text NOT NULL,
	detail text,
	input jsonb NOT NULL DEFAULT '{}'::jsonb,
	status text NOT NULL DEFAULT 'running',
	error text,
	summary text,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (organization_id, project_id, run_id, id),
	CONSTRAINT qa_activities_run_fk
		FOREIGN KEY (organization_id, project_id, run_id)
		REFERENCES qa_runs (organization_id, project_id, id) ON DELETE CASCADE,
	CONSTRAINT qa_activities_id_present CHECK (char_length(btrim(id)) BETWEEN 1 AND 255),
	CONSTRAINT qa_activities_ordinal_positive CHECK (ordinal > 0),
	CONSTRAINT qa_activities_label_present CHECK (char_length(btrim(label)) BETWEEN 1 AND 500),
	CONSTRAINT qa_activities_input_object CHECK (jsonb_typeof(input) = 'object'),
	CONSTRAINT qa_activities_status_valid CHECK (status IN ('running', 'done', 'failed')),
	CONSTRAINT qa_activities_run_ordinal_unique UNIQUE (organization_id, project_id, run_id, ordinal)
);

CREATE INDEX qa_activities_run_order
	ON qa_activities (organization_id, project_id, run_id, ordinal);

CREATE TABLE qa_plan_items (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	run_id uuid NOT NULL,
	position integer NOT NULL,
	text text NOT NULL,
	status text NOT NULL DEFAULT 'pending',
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT qa_plan_items_run_fk
		FOREIGN KEY (organization_id, project_id, run_id)
		REFERENCES qa_runs (organization_id, project_id, id) ON DELETE CASCADE,
	CONSTRAINT qa_plan_items_position_nonnegative CHECK (position >= 0),
	CONSTRAINT qa_plan_items_text_present CHECK (char_length(btrim(text)) BETWEEN 1 AND 5000),
	CONSTRAINT qa_plan_items_status_valid CHECK (status IN ('pending', 'in_progress', 'completed')),
	CONSTRAINT qa_plan_items_run_position_unique UNIQUE (organization_id, project_id, run_id, position)
);

CREATE INDEX qa_plan_items_run_order
	ON qa_plan_items (organization_id, project_id, run_id, position);

CREATE TABLE qa_findings (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	run_id uuid NOT NULL,
	ordinal bigint NOT NULL,
	title text NOT NULL,
	severity text NOT NULL,
	category text NOT NULL DEFAULT 'general',
	page_url text,
	steps text[] NOT NULL DEFAULT ARRAY[]::text[],
	expected text NOT NULL,
	actual text NOT NULL,
	evidence text,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT qa_findings_run_fk
		FOREIGN KEY (organization_id, project_id, run_id)
		REFERENCES qa_runs (organization_id, project_id, id) ON DELETE CASCADE,
	CONSTRAINT qa_findings_ordinal_positive CHECK (ordinal > 0),
	CONSTRAINT qa_findings_title_present CHECK (char_length(btrim(title)) BETWEEN 1 AND 1000),
	CONSTRAINT qa_findings_severity_valid CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
	CONSTRAINT qa_findings_category_present CHECK (char_length(btrim(category)) BETWEEN 1 AND 200),
	CONSTRAINT qa_findings_page_url_size CHECK (page_url IS NULL OR char_length(page_url) <= 8192),
	CONSTRAINT qa_findings_run_ordinal_unique UNIQUE (organization_id, project_id, run_id, ordinal)
);

CREATE INDEX qa_findings_run_order
	ON qa_findings (organization_id, project_id, run_id, ordinal);

CREATE INDEX qa_findings_run_severity
	ON qa_findings (organization_id, project_id, run_id, severity, created_at);

CREATE TABLE qa_reports (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	run_id uuid NOT NULL,
	version integer NOT NULL DEFAULT 1,
	is_current boolean NOT NULL DEFAULT true,
	verdict text NOT NULL,
	summary text NOT NULL,
	covered text[] NOT NULL DEFAULT ARRAY[]::text[],
	not_covered text[] NOT NULL DEFAULT ARRAY[]::text[],
	recommendations text[] NOT NULL DEFAULT ARRAY[]::text[],
	target_url text,
	finding_count bigint NOT NULL DEFAULT 0,
	severity_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
	published_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT qa_reports_run_fk
		FOREIGN KEY (organization_id, project_id, run_id)
		REFERENCES qa_runs (organization_id, project_id, id) ON DELETE CASCADE,
	CONSTRAINT qa_reports_version_positive CHECK (version > 0),
	CONSTRAINT qa_reports_verdict_valid CHECK (verdict IN ('pass', 'pass_with_issues', 'fail', 'blocked')),
	CONSTRAINT qa_reports_target_url_size CHECK (target_url IS NULL OR char_length(target_url) <= 8192),
	CONSTRAINT qa_reports_finding_count_nonnegative CHECK (finding_count >= 0),
	CONSTRAINT qa_reports_severity_counts_object CHECK (jsonb_typeof(severity_counts) = 'object'),
	CONSTRAINT qa_reports_run_version_unique UNIQUE (organization_id, project_id, run_id, version)
);

CREATE UNIQUE INDEX qa_reports_one_current_per_run
	ON qa_reports (organization_id, project_id, run_id)
	WHERE is_current;
