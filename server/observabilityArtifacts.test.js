import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const monitorsUrl = new URL('../deploy/observability/service-monitors.yaml', import.meta.url);
const rulesUrl = new URL('../deploy/observability/prometheus-rules.yaml', import.meta.url);
const dashboardUrl = new URL('../deploy/observability/grafana-dashboard.json', import.meta.url);
const baseUrl = new URL('../deploy/kubernetes/base/qase.yaml', import.meta.url);
const packageScriptUrl = new URL('../scripts/package.mjs', import.meta.url);

test('observability overlay keeps scrape credentials external and labels all fixed roles', async () => {
	const [monitors, rules, base] = await Promise.all([
		readFile(monitorsUrl, 'utf8'), readFile(rulesUrl, 'utf8'), readFile(baseUrl, 'utf8')
	]);
	assert.equal((monitors.match(/kind: ServiceMonitor/g) ?? []).length, 3);
	for (const role of ['api', 'worker', 'control']) assert.match(monitors, new RegExp(`replacement: ${role}\\b`));
	assert.match(monitors, /credentials:\s*\{ name: qase-cell-runtime, key: metrics-token \}/);
	assert.doesNotMatch(monitors, /bearerToken:\s*\S+/);
	assert.match(base, /name: qase-worker-metrics[\s\S]+name: metrics/);
	for (const alert of [
		'QaseApiMetricsAbsent', 'QaseAvailabilityFastBurn', 'QaseAvailabilitySlowBurn',
		'QaseHttpLatencyHigh', 'QaseMutationOverload', 'QaseQueueDepthHigh',
		'QaseQueueWaitHigh', 'QaseExpiredWorkerLeases', 'QaseDeploymentUnavailable'
	]) assert.match(rules, new RegExp(`alert: ${alert}\\b`));
	assert.doesNotMatch(rules, /runbook_url:\s+(?!https:\/\/)/);
});

test('Grafana dashboard is valid, immutable and contains core SLO/queue panels', async () => {
	const dashboard = JSON.parse(await readFile(dashboardUrl, 'utf8'));
	assert.equal(dashboard.uid, 'qase-enterprise-overview');
	assert.equal(dashboard.editable, false);
	assert.ok(dashboard.panels.length >= 8);
	const expressions = JSON.stringify(dashboard.panels.flatMap(panel => panel.targets ?? []));
	assert.match(expressions, /qase:http_error_ratio:5m/);
	assert.match(expressions, /qase_execution_oldest_queued_age_seconds/);
	assert.match(expressions, /qase_execution_expired_leases/);
	assert.doesNotMatch(JSON.stringify(dashboard), /authorization|bearer|password/i);
});

test('safe source archive requires every Phase 8 observability artifact', async () => {
	const script = await readFile(packageScriptUrl, 'utf8');
	for (const artifact of ['service-monitors.yaml', 'prometheus-rules.yaml', 'grafana-dashboard.json']) {
		assert.match(script, new RegExp(`deploy/observability/${artifact.replace('.', '\\.')}`));
	}
});
