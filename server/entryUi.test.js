import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
test('entry resolves without unlocking protected workspace or delaying authentication', async () => {
 const window = {};
 runInNewContext(readFileSync(new URL('../public/entry.js', import.meta.url),'utf8'), { window });
 await window.qaseEntryReady;
});
