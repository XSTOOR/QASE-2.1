# Controlled Qase capacity workload

The k6 workload in this directory is staging-only and read-only. It resolves one
pre-created control-plane placement; it does not create users, runs, placements,
credentials, browser sessions, or reports.

It refuses to start unless:

- `QASE_CAPACITY_ACK` exactly confirms ownership of the staging target;
- the target is an HTTPS origin whose hostname appears exactly in
  `QASE_CAPACITY_ALLOWED_HOSTS`;
- dedicated organization/project UUIDs and a read-only control token are set;
- the release and target use safe aliases.

The default 29-minute profile ramps through 10, 50, 100 and 200 requests/second,
with immediate abort thresholds for excess errors. `QASE_CAPACITY_RATE_MULTIPLIER`
is bounded from 0.1 to 100. Review the resulting traffic/cost and downstream
database limits before setting it above 1.

Example (values must come from the approved staging change record):

```text
QASE_CAPACITY_ACK=I_OWN_THIS_STAGING_TARGET
QASE_CAPACITY_CONTROL_URL=https://control.staging.example.com
QASE_CAPACITY_ALLOWED_HOSTS=control.staging.example.com
QASE_CAPACITY_ORGANIZATION_ID=<dedicated-test-organization-uuid>
QASE_CAPACITY_PROJECT_ID=<dedicated-test-project-uuid>
QASE_CAPACITY_TARGET_ALIAS=control-staging-a
QASE_RELEASE_ID=sha256:<reviewed-image-digest>
QASE_CONTROL_API_READ_TOKEN=<read-token-from-secret-manager>
k6 run load/k6/control-plane-placement.js
```

Review `capacity-evidence.json`, then evaluate it independently:

```text
npm run capacity:evaluate -- capacity-evidence.json deploy/qualification/capacity-policy.example.json
```

Do not commit evidence or credentials. Store reviewed evidence, dashboard
snapshots, infrastructure configuration and approval in the change system.
