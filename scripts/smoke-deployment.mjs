import 'dotenv/config';
import { runSmokeChecks } from '../server/deploymentChecks.js';

const results = await runSmokeChecks();
for (const result of results) {
	console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name} HTTP ${result.status} ${result.durationMs.toFixed(1)}ms`);
}
if (results.some(result => !result.ok)) process.exitCode = 1;
