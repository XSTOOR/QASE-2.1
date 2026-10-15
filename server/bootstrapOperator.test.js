import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('offline bootstrap creates only an empty local store and never prints credentials', t => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-bootstrap-test-'));
 t.after(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('qase-bootstrap-test-'));
  fs.rmSync(root, { recursive: true, force: true });
 });
 const password = randomBytes(24).toString('base64url');
 const env = { ...process.env, QASE_RUN_STORE: 'local', QASE_OPERATOR_EMAIL: 'bootstrap@example.test', QASE_OPERATOR_PASSWORD: password };
 const script = fileURLToPath(new URL('../scripts/bootstrap-operator.mjs', import.meta.url));
 const run = overrides => spawnSync(process.execPath, [script], { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8' });
 const first = run({});
 assert.equal(first.status, 0, first.stderr);
 assert.ok(!first.stdout.includes(password));
 const before = fs.readFileSync(path.join(root, '.qase/auth.json'), 'utf8');
 assert.ok(!before.includes(password));
 assert.equal(JSON.parse(before).users.length, 1);
 assert.notEqual(run({}).status, 0);
 assert.equal(fs.readFileSync(path.join(root, '.qase/auth.json'), 'utf8'), before);
 assert.notEqual(run({ QASE_RUN_STORE: 'postgres' }).status, 0);
});
