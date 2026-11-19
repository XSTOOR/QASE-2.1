/**
 * Safety properties of the QA engine's browser layer. These guard the
 * read-only promise: a QA run must never write to the site under test
 * unless the owner explicitly authorized test writes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createQaBrowser, VIEWPORTS } from './browser.js';

async function site() {
	const received = [];
	const server = http.createServer((request, response) => {
		let body = '';
		request.on('data', chunk => { body += chunk; });
		request.on('end', () => {
			received.push({ method: request.method, url: request.url, body });
			response.writeHead(200, { 'Content-Type': 'text/html' });
			response.end(`<!doctype html><title>t</title>
<form method="post" action="/submit"><input name="a" value="1"><button id="send">Send</button></form>
<button id="xhr" type="button" onclick="fetch('/api/save',{method:'POST',body:'x'})">Save</button>
<button id="gql" type="button" onclick="fetch('/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'{ items { id } }'})})">Load</button>
<a id="out" href="https://example.org/">Away</a>`);
		});
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	return { url: `http://127.0.0.1:${server.address().port}/`, received, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }) };
}

const ENV = { ...process.env, NODE_ENV: 'test', QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: '127.0.0.1' };

test('interaction never sends writes, but GraphQL queries and page loads still work', { timeout: 60_000 }, async () => {
	const target = await site();
	const blocked = [];
	const browser = await createQaBrowser({ session: { targetUrl: target.url, engine: 'chromium' }, env: ENV, onBlocked: event => blocked.push(event) });
	try {
		const { page, log } = await browser.openPage(VIEWPORTS.desktop);
		await browser.goto(page, target.url, log);
		await browser.interact(async () => {
			await page.click('#xhr');
			await page.click('#gql');
			await page.waitForTimeout(400);
			await page.click('#send');
			await page.waitForTimeout(600);
		});
		const writes = target.received.filter(request => request.method !== 'GET');
		assert.deepEqual(writes.map(request => request.url), ['/graphql'], 'only the read-only GraphQL query reached the server');
		assert.ok(blocked.some(event => event.kind === 'write_blocked' && event.url.endsWith('/api/save')));
		assert.ok(blocked.some(event => event.kind === 'write_blocked' && event.url.endsWith('/submit')));
	} finally { await browser.close(); await target.close(); }
});

test('a form POST navigation is blocked even outside an interaction window', { timeout: 60_000 }, async () => {
	const target = await site();
	const browser = await createQaBrowser({ session: { targetUrl: target.url, engine: 'chromium' }, env: ENV });
	try {
		const { page, log } = await browser.openPage(VIEWPORTS.desktop);
		await browser.goto(page, target.url, log);
		await page.evaluate(() => document.forms[0].submit());
		await page.waitForTimeout(800);
		assert.equal(target.received.filter(request => request.method === 'POST').length, 0);
	} finally { await browser.close(); await target.close(); }
});

test('the owner-authorized sign-in window permits exactly the bounded writes', { timeout: 60_000 }, async () => {
	const target = await site();
	const browser = await createQaBrowser({ session: { targetUrl: target.url, engine: 'chromium' }, env: ENV });
	try {
		const { page, log } = await browser.openPage(VIEWPORTS.desktop);
		await browser.goto(page, target.url, log);
		await browser.permitWritesFor(5000, async () => { await page.click('#send'); await page.waitForLoadState('load'); });
		assert.equal(target.received.filter(request => request.method === 'POST').length, 1);
		await browser.goto(page, target.url, log);
		await browser.interact(async () => { await page.click('#send'); await page.waitForTimeout(600); });
		assert.equal(target.received.filter(request => request.method === 'POST').length, 1, 'the window closes after the sign-in');
	} finally { await browser.close(); await target.close(); }
});

test('off-site navigation and private-network targets are blocked by policy', { timeout: 60_000 }, async () => {
	const target = await site();
	const blocked = [];
	let browser, strict;
	try {
		browser = await createQaBrowser({ session: { targetUrl: target.url, engine: 'chromium' }, env: ENV, onBlocked: event => blocked.push(event) });
		const { page, log } = await browser.openPage(VIEWPORTS.desktop);
		await browser.goto(page, target.url, log);
		await page.click('#out', { timeout: 5000 }).catch(() => {});
		await page.waitForTimeout(500);
		assert.ok(page.url().startsWith(target.url), `stays on the target page, not ${page.url()}`);
		assert.ok(blocked.some(event => event.kind === 'offsite_navigation'));
		strict = await createQaBrowser({ session: { targetUrl: target.url, engine: 'chromium' }, env: { ...process.env, NODE_ENV: 'production', QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: '' } });
		assert.equal(await strict.policyAllows(target.url, true), false, 'loopback targets are refused without an explicit allowance');
	} finally { await browser?.close(); await strict?.close(); await target.close(); }
});
