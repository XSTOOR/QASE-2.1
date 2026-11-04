import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { isolatedSqaEnvironment } from '../scripts/sqa-test-runtime.mjs';

const require = createRequire(import.meta.url);
const expressRequire = createRequire(require.resolve('express'));

test('the API proxy dependency rejects cross-family trust bypasses while preserving valid private subnets', () => {
	const proxyaddr = expressRequire('proxy-addr');
	for (const subnet of ['::ffff:10.0.0.0/8', '::/1']) {
		const trust = proxyaddr.compile(subnet);
		for (const client of ['203.0.113.42', '::ffff:203.0.113.42']) assert.equal(trust(client), false, `${subnet} trusted ${client}`);
	}
	for (const subnet of ['10.0.0.0/8', '::ffff:10.0.0.0/104']) {
		const trust = proxyaddr.compile(subnet);
		assert.equal(trust('10.1.2.3'), true); assert.equal(trust('::ffff:10.1.2.3'), true);
		assert.equal(trust('203.0.113.42'), false);
	}
});

test('compressed JSON with trailing bytes cannot terminate the API parser process', { timeout: 15000 }, () => {
	// Keep a decoder crash in a disposable process; the production server and
	// the test runner must never receive this negative fixture.
	const source = `
		import assert from 'node:assert/strict';
		import { createRequire } from 'node:module';
		import { gzipSync } from 'node:zlib';
		const require = createRequire(${JSON.stringify(import.meta.url)});
		const express = require('express');
		const app = express();
		app.use(express.json({limit:'1mb'}));
		app.post('/fixture', (req,res) => res.json(req.body));
		app.get('/healthz', (req,res) => res.send('ok'));
		app.use((error,req,res,next) => res.status(error.status || 400).json({rejected:true}));
		const server = app.listen(0, '127.0.0.1');
		await new Promise(resolve => server.once('listening', resolve));
		try {
			const base = 'http://127.0.0.1:' + server.address().port;
			const body = Buffer.concat([gzipSync(JSON.stringify({fixture:true})),Buffer.from([0]),Buffer.alloc(128*1024,88)]);
			const response = await fetch(base+'/fixture', {method:'POST',headers:{'Content-Type':'application/json','Content-Encoding':'gzip'},body,signal:AbortSignal.timeout(5000)});
			assert.ok([200,400].includes(response.status)); await response.arrayBuffer();
			await new Promise(resolve => setTimeout(resolve,250));
			assert.equal((await fetch(base+'/healthz', {signal:AbortSignal.timeout(2000)})).status,200);
			console.log('parser remained available');
		} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
	`;
	const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10000, windowsHide: true, env: isolatedSqaEnvironment() });
	assert.equal(child.status, 0, child.error?.message ?? child.stderr.slice(-2000));
	assert.match(child.stdout, /parser remained available/);
});
