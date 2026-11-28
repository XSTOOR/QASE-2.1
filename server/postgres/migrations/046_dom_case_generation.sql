ALTER TABLE test_cases ADD COLUMN IF NOT EXISTS generation jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS test_cases_active_dom_key
  ON test_cases (organization_id, project_id, (generation->>'key'))
  WHERE NOT deleted AND generation IS NOT NULL;
