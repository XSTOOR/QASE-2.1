-- Qase control-plane migration 001: cell registry and project placement.

CREATE TABLE qase_cells (
	id uuid PRIMARY KEY,
	name text NOT NULL,
	region text NOT NULL,
	base_url text NOT NULL UNIQUE,
	status text NOT NULL DEFAULT 'active',
	capacity_weight integer NOT NULL DEFAULT 100,
	heartbeat_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	observed_queue_depth integer NOT NULL DEFAULT 0,
	observed_oldest_queue_age_seconds double precision NOT NULL DEFAULT 0,
	lock_version bigint NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT qase_cells_name_valid CHECK (char_length(name) BETWEEN 1 AND 120),
	CONSTRAINT qase_cells_region_valid CHECK (region ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT qase_cells_url_valid CHECK (base_url ~ '^https://[^[:space:]]+$'),
	CONSTRAINT qase_cells_status_valid CHECK (status IN ('active', 'draining', 'disabled')),
	CONSTRAINT qase_cells_capacity_valid CHECK (capacity_weight BETWEEN 1 AND 1000),
	CONSTRAINT qase_cells_observations_valid CHECK (
		observed_queue_depth >= 0 AND observed_oldest_queue_age_seconds >= 0
	)
);

CREATE TABLE qase_project_placements (
	organization_id uuid NOT NULL,
	project_id uuid NOT NULL,
	cell_id uuid NOT NULL REFERENCES qase_cells(id) ON DELETE RESTRICT,
	status text NOT NULL DEFAULT 'active',
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (organization_id, project_id),
	CONSTRAINT qase_project_placements_status_valid CHECK (status IN ('active', 'disabled')),
	CONSTRAINT qase_project_placements_distinct_ids CHECK (organization_id <> project_id)
);

CREATE TABLE qase_control_events (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	event_type text NOT NULL,
	entity_kind text NOT NULL,
	entity_id text NOT NULL,
	correlation_id uuid,
	payload jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT qase_control_events_type_valid CHECK (
		event_type IN ('cell.upserted', 'placement.upserted', 'placement.disabled')
	),
	CONSTRAINT qase_control_events_kind_valid CHECK (entity_kind IN ('cell', 'placement')),
	CONSTRAINT qase_control_events_entity_valid CHECK (char_length(entity_id) BETWEEN 1 AND 100),
	CONSTRAINT qase_control_events_payload_object CHECK (jsonb_typeof(payload) = 'object'),
	CONSTRAINT qase_control_events_payload_size CHECK (octet_length(payload::text) <= 4096)
);

CREATE INDEX qase_cells_placement_candidates
	ON qase_cells (region, status, heartbeat_at, observed_queue_depth);
CREATE INDEX qase_project_placements_cell
	ON qase_project_placements (cell_id) WHERE status = 'active';
CREATE INDEX qase_control_events_created ON qase_control_events (created_at, id);
