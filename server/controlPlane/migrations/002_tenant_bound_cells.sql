-- Qase control-plane migration 002: bind each logical cell to one tenant project.
--
-- The current API/runtime owns a frozen PostgreSQL/RLS tenant context. A cell
-- therefore cannot safely serve placements for a different project. Existing
-- cells remain unbound until their trusted heartbeat registration supplies the
-- configured organization/project; placement selection fails closed meanwhile.

ALTER TABLE qase_cells
	ADD COLUMN bound_organization_id uuid,
	ADD COLUMN bound_project_id uuid;

ALTER TABLE qase_cells
	ADD CONSTRAINT qase_cells_tenant_binding_complete CHECK (
		(bound_organization_id IS NULL AND bound_project_id IS NULL)
		OR (
			bound_organization_id IS NOT NULL
			AND bound_project_id IS NOT NULL
			AND bound_organization_id <> bound_project_id
		)
	);

-- Multiple independently registered cells may serve the same project for
-- regional failover or blue/green migration. Selection still requires an exact
-- tenant binding and the placement table chooses only one active destination.
CREATE INDEX qase_cells_tenant_placement_candidates
	ON qase_cells (bound_organization_id, bound_project_id, region, status, heartbeat_at);
