# Single-pod alert definitions (launch topology)

QASE's deployed reality (per `docs/operations-runbook.md` §1–2) is a **single
pod behind a TLS edge with a persistent volume** — not the Prometheus-Operator
K8s topology that `prometheus-rules.yaml` targets. This file defines the
equivalent alert set for the deployed shape: point any uptime checker or
scrape job at the instance and evaluate these expressions.

## Prerequisites

- `QASE_METRICS_TOKEN` is set (64-hex secret, backend env key). `/metrics`
  requires `Authorization: Bearer <token>`.
- Scrape interval: **30s** recommended.

## Alert set

| Alert | Expression (PromQL-ish) | For | Notes |
|---|---|---|---|
| **QaseMetricsAbsent** | `up{job="qase"} == 0` for 3m | page | Scrape/instance down or token rotated. |
| **QaseAvailabilityFastBurn** | 5xx rate on `sum(rate(qase_http_requests_total{status_class="5xx"}[5m])) / sum(rate(qase_http_requests_total[5m])) > 0.05` for 5m | page | Fast burn: >5% of requests 5xx over 5m. |
| **QaseHttpLatencyHigh** | histogram_quantile(0.95, sum(rate(qase_http_request_duration_seconds_bucket[10m])) by (le)) > 2 for 10m | ticket | p95 latency over 2s for 10 minutes. |
| **QaseMutationOverload** | `increase(qase_http_overload_rejections_total[10m]) > 0` | ticket | Server shed load; investigate concurrent runs. |
| **QaseQueueWaitHigh** | `qase_execution_oldest_queued_age_seconds > 300` for 5m | ticket | A queued run has waited >5m — capacity or stuck queue. |
| **QaseExpiredLeases** | `increase(qase_execution_expired_leases[30m]) > 0` | ticket | Worker lease expired mid-run; check run recovery. |
| **QaseRssCeiling** | `process_resident_memory_bytes > 1.5e9` for 15m | ticket | Sustained RSS >1.5 GB — leak or runaway run. |

Signal names are exactly what `server/operations.js` exports. If your checker
is a simple uptime monitor rather than Prometheus, the minimum viable pair is
**QaseMetricsAbsent** (GET `/metrics` with token → 200) and
**QaseAvailabilityFastBurn** (GET `/healthz` → 200, page on 3 consecutive
failures).

## Cadence before launch (from deploy/observability/README.md)

1. Trigger one alert deliberately (wrong token → QaseMetricsAbsent) and verify
   it routes to the on-call channel.
2. Observe one clean 24h window with zero pages.
