# Phase 2: PostgreSQL and tenant foundation

Scope: durable, tenant-scoped QA domain persistence with a reversible local
adapter. This phase does not add Drytis SSO, distributed browser workers, a job
queue, a shared secrets manager or cross-server realtime delivery.

## Storage selection

`QASE_RUN_STORE=local` remains the default. It keeps the Phase 1 JSON behavior
and is the rollback switch during migration validation.

`QASE_RUN_STORE=postgres` is explicit opt-in. It requires
`QASE_DATABASE_URL` (or `DATABASE_URL`). A connection, migration or repository
failure fails startup; Qase never falls back to JSON automatically because that
would create two authoritative histories.

The composition boundary is `server/serviceFactory.js`. Both adapters implement
the same asynchronous run mutations and lifecycle contract.

## Trusted bootstrap scope

Until Drytis identity is approved, every request is bound to one process-
configured bootstrap scope:

- organization
- local owner identity and owner membership
- default project

Stable deterministic UUIDs are supplied for a fresh local deployment and may
be overridden only through trusted environment variables. Request bodies,
query parameters and headers cannot select an organization or project.

The PostgreSQL repository also includes explicit organization and project
predicates on every operation. Cross-scope IDs are indistinguishable from
missing IDs.

## Schema and migrations

Forward-only SQL migrations live in `server/postgres/migrations/` and create:

- organizations, users, organization memberships and projects
- runs, messages, activities, plan items, findings and versioned reports
- append-only durable run events
- idempotent legacy-import history

Tenant-owned child tables carry organization and project keys and use composite
foreign keys back to their parent. This prevents a child row from being attached
to another tenant's run even if application code is wrong.

The migration runner:

- hashes every migration and validates the database history as an exact prefix
- serializes migrators with a PostgreSQL advisory lock
- applies and records each migration in one transaction
- rolls back failures and always releases the client and lock

Run migrations explicitly in a deployment step:

```text
npm run db:migrate
```

Set `QASE_MIGRATION_DATABASE_URL` for that step to a dedicated table-owner/DDL
credential. The running API should use a different `QASE_DATABASE_URL` role
with only the required DML grants, no table ownership, no superuser privileges
and no `BYPASSRLS`. Role creation and grants are intentionally deployment-owned
because PostgreSQL role names and security administration differ by platform.

Development checks/applies the same migrations at startup by default. Production
defaults `QASE_DATABASE_MIGRATE_ON_START` to false so deployments can use a
dedicated non-application migrator credential. When explicitly enabled, the
advisory lock makes concurrent startup safe.

## Tenant isolation

Every tenant table has forced row-level security. Policies read transaction-
local `qase.organization_id` and `qase.project_id` settings and default to no
rows when either setting is absent. Repository transactions set both values
with `set_config(..., true)` and also include explicit predicates.

The API database role must be non-superuser, must not own the tables and must
not have `BYPASSRLS`. RLS is defense in depth; the bound application scope is
still the first authorization boundary.

## Durable mutation semantics

The HTTP layer, browser agent, QA tools and browser bridge no longer import the
local store directly. Durable mutations are awaited through the selected run
service. PostgreSQL writes the normalized aggregate and its durable event in one
short transaction, advances an optimistic lock version, commits, then publishes
the process-local SSE event.

Frames, cursor positions, reasoning, token deltas and live turn markers remain
ephemeral and are never written to PostgreSQL.

The hydrated aggregate remains in the execution process while a CleanSlate
runtime owns it. This preserves the current conversation/browser behavior;
distributed runtime leases and worker ownership belong to a later approved
phase.

Development retains the old restart behavior and marks stale active runs as
`interrupted`. Production defaults `QASE_POSTGRES_RECOVER_ACTIVE_RUNS` to false
so a newly started API replica cannot interrupt a run owned by another process.
After a crashed execution host, enable it only for one controlled recovery
startup, then disable it again. Worker leases will automate this safely later.

## Legacy JSON import

Import is explicit and never runs during normal startup.

1. Back up `.qase/sessions.json`.
2. Validate without writing:

   ```text
   npm run db:import
   ```

3. Review the counts and SHA-256 hash.
4. Apply in a maintenance window:

   ```text
   npm run db:import -- --apply
   ```

The importer preserves run IDs, timestamps and array order; removes historical
reasoning messages; converts stale active runs to `interrupted`; clears pending
questions for those runs; and clears secret names because their vault values do
not survive a restart. Runtime handles, frames, unknown properties and
credential-shaped values are rejected or removed.

`--apply` creates a hash-named backup beside the source before connecting to the
database. The database import is all-or-nothing and records the source hash. Reapplying
the same file is a no-op; conflicting existing run IDs abort without overwrite.
The source JSON is never modified.

## Rollback

Do not dual-write.

1. Stop Qase and retain the source JSON backup.
2. Switch `QASE_RUN_STORE=local`.
3. Restart the single local instance.

Runs created only after switching to PostgreSQL are not copied back
automatically. A rollback therefore restores the pre-cutover JSON checkpoint;
exporting later PostgreSQL-only runs is a separate controlled operation.

## Limitations intentionally retained

- Authentication still uses the local single-owner auth file.
- Credential values and browser/model runtime state are process-local.
- Active execution must stay on one API/agent process in Phase 2.
- SSE uses one process-local event bus and has no broker replay.
- CleanSlate conversation state remains under `.qase/workspaces`.
- PostgreSQL makes domain data durable, but does not yet make browser execution
  horizontally scalable.

These constraints are the input to the next approval gate; they are not hidden
claims of million-user readiness.
