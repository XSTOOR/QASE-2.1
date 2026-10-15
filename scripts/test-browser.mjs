import { spawnSync } from 'node:child_process';
const files = [
	'server/browserMedia.integration.test.js',
	'server/browserMedia.camera.integration.test.js',
	'server/browserBridge.video.integration.test.js',
	'server/securitySuite.integration.test.js',
	'server/multiEngine.integration.test.js'
];
let failed = false;
for (const file of files) {
	const result = spawnSync(process.execPath, ['--test', file], {
		stdio: 'inherit', env: {...process.env, QASE_RUN_BROWSER_TESTS:'1'}
	});
	if ((result.status ?? 1) !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
