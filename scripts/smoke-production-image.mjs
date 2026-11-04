/** Disposable image canary only. Never reads deployment env files, starts model
 * inference, or mounts existing account/run volumes. Requires a Docker daemon. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

const image = process.argv[2] || 'qase:verification';
if (!/^[A-Za-z0-9][A-Za-z0-9_./:@-]*$/.test(image)) throw new Error('Provide a valid image tag or digest.');
const suffix = randomUUID(), name = `qase-image-smoke-${suffix}`;
const volumes = [`${name}-state`, `${name}-evidence`], createdVolumes = [];
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 }).trim();
const release = JSON.parse(fs.readFileSync(new URL('../public/release.json', import.meta.url)));
let containerCreated = false;
try {
  const info = JSON.parse(docker(['image', 'inspect', image]))[0];
  assert.equal(info.Config.User, 'node');
  assert.equal(info.Config.Labels['org.opencontainers.image.version'], release.releaseId);
  for (const volume of volumes) { docker(['volume', 'create', volume]); createdVolumes.push(volume); }
  const environment = {
    NODE_ENV: 'production', QASE_HOST: '0.0.0.0', PORT: '5173', QASE_PUBLIC_URL: 'https://fixture.example.invalid',
    QASE_AUTH_REQUIRED: 'true', QASE_OPEN_REGISTRATION: 'false', QASE_RUN_STORE: 'local', QASE_EXECUTION_MODE: 'local',
    QASE_ARTIFACT_DIR: '/app/evidence', QASE_HYBRID_QA_ENABLED: 'false', QASE_HEADLESS: 'true',
    QASE_PROVIDER: 'custom', QASE_BASE_URL: 'https://llm.drytis.ai/v1', QASE_MODEL: 'drytis/claude-opus-4.7',
    QASE_API_KEY: 'ci-fixture-not-a-real-credential', QASE_BOOTSTRAP_ORGANIZATION_ID: randomUUID(),
    QASE_BOOTSTRAP_PROJECT_ID: randomUUID(), QASE_BOOTSTRAP_USER_ID: randomUUID(),
    QASE_BOOTSTRAP_USER_EMAIL: 'image-fixture@example.invalid', QASE_LOG_FORMAT: 'json'
  };
  docker(['create', '--name', name, '--init', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--shm-size=1g',
    '--tmpfs', '/tmp:uid=1000,gid=1000,mode=1777', '--tmpfs', '/home/node:uid=1000,gid=1000,mode=0700',
    '--mount', `type=volume,src=${volumes[0]},dst=/app/.qase`, '--mount', `type=volume,src=${volumes[1]},dst=/app/evidence`,
    '--publish', '127.0.0.1::5173', ...Object.entries(environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), image]);
  containerCreated = true; docker(['start', name]);
  const address = docker(['port', name, '5173/tcp']);
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  const base = `http://${address}`, deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline) {
    try { const response = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(2000) }); ready = response.ok; await response.body?.cancel(); } catch { /* bounded startup poll */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, 'Production image did not become ready.');
  for (const route of ['/healthz', '/readyz', '/']) assert.equal((await fetch(`${base}${route}`)).status, 200);
  for (const route of ['/api/sessions', '/api/config']) assert.equal((await fetch(`${base}${route}`)).status, 401);
  assert.equal((await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/demo`)).status, 404);
  const actual = await (await fetch(`${base}/release.json`)).json();
  assert.equal(actual.releaseId, release.releaseId); assert.equal(actual.uiVersion, release.uiVersion);
  const browserProbe = `import { chromium, firefox, webkit } from 'playwright';
    for (const [name, engine] of Object.entries({chromium,firefox,webkit})) {
      const browser=await engine.launch({headless:true});
      try { const page=await browser.newPage(); await page.setContent('<title>Owned image fixture</title><h1>Browser ready</h1>');
        if(await page.title()!=='Owned image fixture')throw Error(name+' fixture failed');
      } finally { await browser.close(); }
    }
    console.log('Three installed browser engines launched successfully.');`;
  docker(['exec', name, 'node', '--input-type=module', '-e', browserProbe]);
  console.log(JSON.stringify({ passed: true, releaseId: release.releaseId, nonRoot: true, readOnlyRoot: true, persistentVolumes: true,
    authenticationRequired: true, registrationClosed: true, demoDisabled: true, browserEngines: ['chromium', 'firefox', 'webkit'], modelCalls: 0 }));
} catch (error) {
  if (containerCreated) { try { process.stderr.write(docker(['logs', '--tail', '35', name]) + '\n'); } catch { /* preserve primary failure */ } }
  throw error;
} finally {
  if (containerCreated) docker(['rm', '--force', name]);
  for (const volume of createdVolumes) docker(['volume', 'rm', volume]);
}
