import { spawnSync } from 'node:child_process';
// Real-Chromium integration suites of the three stage engines.
const files = [
	'server/qa/engine.integration.test.js',
	'server/sqa/sqa.integration.test.js',
	'server/founder/founder.integration.test.js'
];
let failed = false;
for (const file of files) {
	const result = spawnSync(process.execPath, ['--test', file], {
		stdio: 'inherit', env: {...process.env, QASE_RUN_BROWSER_TESTS:'1'}
	});
	if ((result.status ?? 1) !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
