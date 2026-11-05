-- Qase PostgreSQL migration 043: trusted actor bootstrap visibility.
-- A newly inserted owner has no membership yet. INSERT ... RETURNING must
-- see that owner's row without granting visibility to another tenant's users.
-- Only host transaction-local trusted actor/tenant scope enables this clause.
DROP POLICY users_select_tenant_scope ON users;
CREATE POLICY users_select_tenant_scope ON users
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM organization_memberships membership
      WHERE membership.organization_id = NULLIF(current_setting('qase.organization_id', true), '')::uuid
        AND membership.user_id = users.id AND membership.status = 'active'
    ) OR (
      users.id = NULLIF(current_setting('qase.actor_user_id', true), '')::uuid
      AND NULLIF(current_setting('qase.organization_id', true), '')::uuid IS NOT NULL
      AND NULLIF(current_setting('qase.project_id', true), '')::uuid IS NOT NULL
    )
  );
