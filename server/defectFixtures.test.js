import test, { before, after } from 'node:test';
import express from 'express';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { generateEnvironments } from './environmentCatalog.js';
import { getDefectFixture, listDefectFixtures, fixtureExpectation, mountDefectFixtures } from './defectFixtures.js';
import { verifyFixtureAgainstProfile } from './defectFixtureRunner.js';

let BASE_URL;
let fixtureServer;
before(async () => {
	const app = express();
	mountDefectFixtures(app);
	fixtureServer = app.listen(0, '127.0.0.1');
	await once(fixtureServer, 'listening');
	BASE_URL = `http://127.0.0.1:${fixtureServer.address().port}`;
});
after(async () => {
	if (fixtureServer) await new Promise((resolve, reject) => fixtureServer.close(error => error ? reject(error) : resolve()));
});

test('production wiring shape: stripped listing resolved back to full fixture executes (not NOT_VERIFIED)', { timeout: 120_000 }, async () => {
	// app.js wires verifyFixtures: listDefectFixtures() (summary-only, no
	// verify/affects) and resolves the full fixture via getDefectFixture(id)
	// inside runFixtureVerification. This test exercises exactly that shape.
	const summaries = listDefectFixtures();
	const summary = summaries.find((f) => f.id === 'login-button-overlaps-keyboard');
	assert.ok(summary, 'summary entry exists');
	assert.equal(summary.verify, undefined, 'listing must be function-free (serializable)');
	assert.equal(summary.affects, undefined);

	const envs = generateEnvironments();
	const iphone = envs.find((e) => e.envId === 'ENV-IOS-IP17PRO-26.0-SAF-26.0');
	const full = getDefectFixture(summary.id);
	assert.ok(full?.verify && typeof full.affects === 'function', 'full fixture carries probe + predicate');

	const expectation = fixtureExpectation(full, iphone);
	assert.equal(expectation, 'EXPECTED');

	const verdict = await verifyFixtureAgainstProfile({ fixture: full, environment: iphone, baseUrl: BASE_URL });
	assert.equal(verdict.reproduced, 'TRUE', `should execute under the wiring shape: ${JSON.stringify(verdict)}`);
	assert.ok(verdict.evidence);
});

test('fixture registry lists representative known defects with expectations', () => {
	const registry = listDefectFixtures();
	assert.ok(registry.length >= 2, 'registry should have at least the two fixtures');
	assert.ok(registry.some((f) => f.id === 'login-button-overlaps-keyboard'));
	assert.ok(registry.some((f) => f.id === 'wide-table-overflow'));
	for (const fixture of registry) {
		assert.ok(fixture.title && fixture.description && fixture.expectedSummary);
	}
});

test('fixture expectation predicate separates touch profiles from desktop', () => {
	const loginFixture = getDefectFixture('login-button-overlaps-keyboard');
	const iphone = { deviceType: 'mobile' };
	const ipad = { deviceType: 'tablet' };
	const desktop = { deviceType: 'desktop' };
	assert.equal(fixtureExpectation(loginFixture, iphone), 'EXPECTED');
	assert.equal(fixtureExpectation(loginFixture, ipad), 'EXPECTED');
	assert.equal(fixtureExpectation(loginFixture, desktop), 'NOT_EXPECTED');
	assert.equal(fixtureExpectation(null, iphone), 'NOT_VERIFIED');
});

test('login-button fixture REPRODUCES on iPhone + iPad (touch), NOT on desktop — actual execution', { timeout: 120_000 }, async () => {
	const fixture = getDefectFixture('login-button-overlaps-keyboard');
	const envs = generateEnvironments();
	const iphone = envs.find((e) => e.envId === 'ENV-IOS-IP17PRO-26.0-SAF-26.0');
	const ipad = envs.find((e) => e.envId === 'ENV-IPADOS-IPADPRO129-1-13.0-SAF-13.0');
	const desktop = envs.find((e) => e.platform === 'windows' && e.deviceType === 'desktop' && e.browserCode === 'chrome');
	assert.ok(iphone, 'iPhone 17 Pro environment must exist in catalog');
	assert.ok(ipad, 'iPad Pro tablet environment must exist in catalog');
	assert.ok(desktop, 'Windows 11 desktop environment must exist in catalog');

	const onPhone = await verifyFixtureAgainstProfile({ fixture, environment: iphone, baseUrl: BASE_URL });
	assert.equal(onPhone.reproduced, 'TRUE', `phone should reproduce: ${JSON.stringify(onPhone)}`);
	assert.ok(onPhone.evidence, 'phone result carries probe evidence');

	const onTablet = await verifyFixtureAgainstProfile({ fixture, environment: ipad, baseUrl: BASE_URL });
	assert.equal(onTablet.reproduced, 'TRUE', `tablet should reproduce (touch form factor): ${JSON.stringify(onTablet)}`);

	const onDesktop = await verifyFixtureAgainstProfile({ fixture, environment: desktop, baseUrl: BASE_URL });
	assert.equal(onDesktop.reproduced, 'FALSE', `desktop should not reproduce: ${JSON.stringify(onDesktop)}`);
	assert.ok(onDesktop.evidence);
});

test('wide-table fixture reproduces on phone viewport, not tablet/desktop', { timeout: 120_000 }, async () => {
	const fixture = getDefectFixture('wide-table-overflow');
	const envs = generateEnvironments();
	const phone = envs.find((e) => e.envId === 'ENV-IOS-IP17PRO-26.0-SAF-26.0');
	const tablet = envs.find((e) => e.envId === 'ENV-IPADOS-IPADPRO129-1-13.0-SAF-13.0');
	assert.ok(tablet, 'iPad Pro 12.9 tablet environment must exist in catalog');
	assert.equal(tablet.deviceType, 'tablet', 'tablet env must be deviceType tablet, not phone');

	const onPhone = await verifyFixtureAgainstProfile({ fixture, environment: phone, baseUrl: BASE_URL });
	assert.equal(onPhone.reproduced, 'TRUE', `phone overflow expected: ${JSON.stringify(onPhone)}`);
	// Tablet viewport (1024+) fits the 6-column table — defect must NOT reproduce.
	const onTablet = await verifyFixtureAgainstProfile({ fixture, environment: tablet, baseUrl: BASE_URL });
	assert.equal(onTablet.reproduced, 'FALSE', `tablet should fit: ${JSON.stringify(onTablet)}`);
});

test('NOT_VERIFIED — never a guess — when inputs are missing', async () => {
	const fixture = getDefectFixture('login-button-overlaps-keyboard');
	const noFixture = await verifyFixtureAgainstProfile({ fixture: null, environment: {}, baseUrl: BASE_URL });
	assert.equal(noFixture.reproduced, 'NOT_VERIFIED');
	assert.ok(noFixture.error);
	const badUrl = await verifyFixtureAgainstProfile({ fixture, environment: { browserCode: 'chrome', deviceType: 'desktop' }, baseUrl: 'http://127.0.0.1:1' });
	assert.equal(badUrl.reproduced, 'NOT_VERIFIED');
	assert.ok(badUrl.error);
});
