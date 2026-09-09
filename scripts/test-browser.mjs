import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['--test', 'server/browserMedia.integration.test.js'], {
	stdio: 'inherit', env: {...process.env, QASE_RUN_BROWSER_TESTS:'1'}
});
process.exit(result.status ?? 1);
