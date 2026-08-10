# Qase observability overlay

This optional overlay targets the Prometheus Operator and Grafana. It does not
install either product. Review it with the platform/SRE team before applying.

1. Ensure the Operator CRDs (`ServiceMonitor`, `PrometheusRule`) and
   kube-state-metrics exist.
2. Apply the Phase 7 base first. The monitors reuse only the external
   `metrics-token` keys; they contain no credential values.
3. Make the Prometheus resource select objects labelled
   `app.kubernetes.io/part-of=qase`, then apply both YAML files here.
4. Replace every `runbooks.example.invalid` annotation with the reviewed,
   reachable internal runbook origin.
5. Import `grafana-dashboard.json`, selecting the production Prometheus data
   source for `DS_PROMETHEUS`.
6. Confirm all three roles appear, deliberately trigger a staging-only alert,
   verify routing/on-call ownership, then run a full SLO window before launch.

Keep metrics endpoints on private networks. Prometheus reads bearer tokens from
externally managed Kubernetes Secrets. Do not add tokens to these files or to
Grafana variables.
