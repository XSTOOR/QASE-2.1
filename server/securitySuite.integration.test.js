import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { once } from 'node:events';
import { attachBrowserBridge } from './browserBridge.js';
import { createBrowserPolicy } from './browserPolicy.js';
import { mountDemoSite } from './demoSite.js';

const browserTests = process.env.QASE_RUN_BROWSER_TESTS === '1';

/**
 * Live security-suite tests against the demo site's deliberately vulnerable
 * sandbox pages (positive cases) and its escaped pages (negative cases).
 */
async function setup(t) {
	const app = express();
	mountDemoSite(app);
	const server = app.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const targetUrl = `http://127.0.0.1:${server.address().port}/demo`;
	const { CleanSlateNodeBrowserAutomation } = await import(new URL('./node/cleanSlateNodeBrowserAutomation.js', import.meta.resolve('@cleanslate/sdk')));
	const service = new CleanSlateNodeBrowserAutomation({ headless: true });
	const session = { id: 'security-fixture', targetUrl, messages: [], status: 'running' };
	const events = [];
	const store = {
		publish(_session, type, payload) { events.push({ type, payload }); },
		async commit(_session, type, payload) { events.push({ type, payload }); }
	};
	const policy = createBrowserPolicy({
		getTargetUrl: () => targetUrl,
		// The suite hits the loopback demo server; the private-network guard is
		// relaxed exactly for this fixture, the way local development does it.
		environment: { NODE_ENV: 'development', QASE_ALLOW_PRIVATE_NETWORK: 'true' }
	});
	const bridge = attachBrowserBridge(session, service, store, { policy });
	t.after(async () => {
		bridge.dispose?.();
		await service.dispose().catch(() => undefined);
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	});
	await service.open(`${targetUrl}/vuln/search`);
	bridge.stopFrames();
	return { service, bridge, targetUrl, events };
}

test('security suite detects the unescaped XSS reflection sandbox', { skip: !browserTests, timeout: 60000 }, async t => {
	const { bridge, targetUrl } = await setup(t);
	await bridge.service.open(`${targetUrl}/vuln/search`);
	const report = await bridge.runSecurityChecks({ checks: ['xss_reflection'] });
	assert.equal(report.success, true);
	const xss = report.results.find(result => result.id === 'xss_reflection');
	assert.ok(xss, 'xss_reflection result present');
	assert.equal(xss.status, 'fail', `unescaped sandbox should fail, got ${JSON.stringify(xss)}`);
	assert.equal(xss.severity, 'high');
});

test('security suite does not flag the escaped search page', { skip: !browserTests, timeout: 60000 }, async t => {
	const { bridge, targetUrl } = await setup(t);
	// The escaped page lives behind the demo login; sign in first.
	await bridge.service.open(`${targetUrl}/login`);
	await bridge.service.fill('ide', { selector: 'input[name="email"]', value: 'demo@qase.dev' });
	await bridge.service.fill('ide', { selector: 'input[name="password"]', value: 'demo1234' });
	await bridge.service.click('ide', { selector: 'button[type="submit"]' });
	await bridge.service.activePage.waitForURL(/\/demo\/app$/);
	const report = await bridge.runSecurityChecks({ checks: ['xss_reflection'] });
	const xss = report.results.find(result => result.id === 'xss_reflection');
	assert.ok(xss);
	assert.notEqual(xss.status, 'fail', `escaped page must not be flagged as XSS, got ${JSON.stringify(xss)}`);
});

test('security suite detects the SQL error signature sandbox', { skip: !browserTests, timeout: 60000 }, async t => {
	const { bridge, targetUrl } = await setup(t);
	await bridge.service.open(`${targetUrl}/vuln/notes`);
	const report = await bridge.runSecurityChecks({ checks: ['sqli_error_signature'] });
	const sqli = report.results.find(result => result.id === 'sqli_error_signature');
	assert.ok(sqli);
	assert.equal(sqli.status, 'fail', `injectable notes page should fail, got ${JSON.stringify(sqli)}`);
	assert.equal(sqli.severity, 'high');
	assert.match(sqli.evidence, /signature/i);
});

test('header checks read the live response and flag the headerless demo', { skip: !browserTests, timeout: 60000 }, async t => {
	const { bridge, targetUrl } = await setup(t);
	await bridge.service.open(`${targetUrl}/vuln/search`);
	const report = await bridge.runSecurityChecks({ checks: ['csp', 'hsts', 'x_content_type_options'] });
	const ids = report.results.map(result => result.id);
	assert.deepEqual(ids.sort(), ['csp', 'hsts', 'x_content_type_options']);
	for (const result of report.results) {
		assert.equal(result.status, 'fail', `${result.id} should be absent → fail`);
	}
	assert.match(report.results.find(r => r.id === 'csp').remediation, /Content-Security-Policy/);
});

test('the full default suite runs every check and commits a security event', { skip: !browserTests, timeout: 90000 }, async t => {
	const { bridge, events } = await setup(t);
	const report = await bridge.runSecurityChecks();
	assert.equal(report.success, true);
	const ids = report.results.map(result => result.id).sort();
	for (const id of ['csp', 'hsts', 'cookie_flags', 'xss_reflection', 'sqli_error_signature', 'mixed_content']) {
		assert.ok(ids.includes(id), `${id} should be in the default suite`);
	}
	assert.ok(report.limitations.includes('not a full penetration test'));
	const committed = events.filter(event => event.type === 'security');
	assert.equal(committed.length, 1, 'one security commit per run');
	assert.equal(committed[0].payload.securityReport.results.length, report.results.length);
});

test('the security_check tool is QA-only', async () => {
	const { allowedToolNames } = await import('./agent.js');
	assert.ok(allowedToolNames('qa').has('security_check'), 'QA gets the security tool');
	assert.ok(!allowedToolNames('sqa').has('security_check'), 'SQA must not fire payloads');
	assert.ok(!allowedToolNames('founder').has('security_check'), 'Founder never probes');
});
