import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static contract tests for the Phase-9 Drytis board push (QASE side):
 * the report-view panel (accept checkboxes, accept-all, push button),
 * its CSS, the hex nonce fix, and the dormant default.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const appJs = fs.readFileSync(path.join(here, '../public/app.js'), 'utf8');
const styles = fs.readFileSync(path.join(here, '../public/styles.css'), 'utf8');
const transportJs = fs.readFileSync(path.join(here, './drytisTransport.js'), 'utf8');
const qaseClientJs = fs.readFileSync(path.join(here, '../integrations/drytis/qaseClient.js'), 'utf8');
const apiJs = fs.readFileSync(path.join(here, './app.js'), 'utf8');

test('report view renders the Drytis board only for attached reviews', () => {
	assert.match(appJs, /state\.session\?\.drytisIntegration/, 'panel gated on session.drytisIntegration');
	assert.match(appJs, /function renderDrytisBoard\(/, 'panel renderer');
	assert.match(appJs, /function renderDrytisBoardRefresh\(/, 'in-place refresh after push');
});

test('board panel has per-finding accept checkboxes, accept-all and a push button', () => {
	assert.match(appJs, /box\.dataset\.drytisFinding = finding\.id/, 'per-finding checkbox marker');
	assert.match(appJs, /allBox\.id = 'drytis-accept-all'/, 'accept-all master checkbox');
	assert.match(appJs, /push\.id = 'drytis-push-btn'/, 'push button');
	assert.match(appJs, /box\.checked = true/, 'checkboxes default checked (accept-all first)');
});

test('push posts accepted ids to the dashboard endpoint', () => {
	assert.match(appJs, /\/sessions\/\$\{state\.session\.id\}\/drytis\/push/);
	assert.match(appJs, /acceptedFindingIds/);
	assert.match(appJs, /drytis-board-done/, 'delivered state rendered');
	assert.match(appJs, /drytis-board-busy/, 'delivering state rendered');
	assert.match(appJs, /drytis-board-failed/, 'failed state rendered with retry');
	assert.match(appJs, /document\.getElementById\('drytis-board'\)/, 'in-place refresh keeps layout');
});

test('board panel styles exist', () => {
	assert.match(styles, /\.drytis-board \{/);
	assert.match(styles, /\.drytis-board-rows \{/);
	assert.match(styles, /\.drytis-board-acceptall \{/);
});

test('nonce generators produce hex on both sides of the integration', () => {
	// Server transport: randomBytes(24) -> 48 hex chars.
	assert.match(transportJs, /createNonce = \(\) => randomBytes\(24\)\.toString\('hex'\)/);
	// Drytis-side client: randomBytes(18) -> 36 hex chars.
	assert.match(qaseClientJs, /createNonce = \(\) => randomBytes\(18\)\.toString\('hex'\)/);
	// No base64url NONCE generation remains (the leading -/_ flake source);
	// base64url decoding of signing keys is unrelated and allowed.
	const nonceInTransport = [...transportJs.matchAll(/createNonce[^,\n]*/g)].join(' ');
	assert.doesNotMatch(nonceInTransport, /base64/);
	const nonceInClient = [...qaseClientJs.matchAll(/createNonce[^,\n]*/g)].join(' ');
	assert.doesNotMatch(nonceInClient, /base64/);
});

test('dashboard push endpoint is dormant without a delivery client', () => {
	// The endpoint 409s (never 500s) when the integration is unconfigured.
	assert.match(apiJs, /Drytis ticket push is not configured on this instance/);
	assert.match(apiJs, /drytisDelivery\?\.deliveryClient/, 'gate reads the configured delivery client');
	assert.match(apiJs, /drytis\.tickets\.completed/, 'success event recorded');
	assert.match(apiJs, /drytis\.tickets\.failed/, 'failure event recorded');
});
