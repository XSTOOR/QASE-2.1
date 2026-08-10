# Qase Kubernetes baseline

This directory is a reviewable production baseline, not a one-command cloud
installer. It intentionally does not create PostgreSQL, Redis, DNS, ingress,
TLS certificates or Kubernetes `Secret` objects. Supply those through the
organization's managed services and secrets operator.

Before applying anything:

1. Build the root `Dockerfile`, scan it, sign it, push it, and replace every
   `registry.example.invalid/qase:phase-7` reference with the immutable digest.
2. Replace the cell UUID/name/region/public URL in `base/qase.yaml`.
3. Create the externally managed secret objects and keys referenced by the
   manifests. Runtime database roles must be non-owner, non-superuser and lack
   `BYPASSRLS`; migrator roles are separate.
4. Add provider-specific ingress, TLS, egress policy, external secrets,
   monitoring and workload identity overlays. Permit the heartbeat workload to
   reach only the API metrics endpoint and control API.
5. Apply `base/migrations.yaml` and wait for both Jobs to succeed. Then apply
   `base/qase.yaml`. Never let normal application startup run migrations.
6. Verify all probes, perform a signed Drytis canary, and run the bounded smoke
   check before adding traffic.

The worker HPA's CPU policy is a conservative bootstrap. Replace it with a
reviewed custom-metrics policy based on queued jobs and oldest queued age after
measuring browser/provider saturation in that cell. Do not autoscale solely on
request count, and do not scale workers beyond database, Redis, browser, model
provider, or target-site limits.

The two heartbeat replicas may publish the same idempotent observation. They
are the only cell workload that receives the global control-plane write token;
API and worker pods must not receive it.

Required externally managed objects are:

- `qase-cell-runtime`: `database-url`, `redis-url`, `secrets-master-key`,
  `metrics-token`, `model-api-key`;
- `qase-control-runtime`: `database-url`, `read-token`, `write-token`,
  `metrics-token`;
- `qase-heartbeat-runtime`: `control-write-token`, `metrics-token` (the same
  values accepted by control and cell metrics respectively);
- `qase-cell-migrator` and `qase-control-migrator`: `database-url` for their
  separate DDL roles.

The checked-in pool limits are per pod. Put PostgreSQL behind a reviewed
transaction-aware pooler and size database connections for the maximum replica
count before increasing any HPA maximum.
