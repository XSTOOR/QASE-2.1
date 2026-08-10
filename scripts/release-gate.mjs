import 'dotenv/config';
import { runReleaseGate } from '../server/deploymentChecks.js';

const report = await runReleaseGate();
console.log(JSON.stringify({
	releaseId: report.releaseId,
	passed: report.passed,
	maximumP95Ms: report.maximumP95Ms,
	targets: report.targets.map(target => ({
		name: target.name,
		attempts: target.attempts,
		passed: target.passed,
		p95Ms: Number(target.p95Ms.toFixed(1)),
		statuses: target.statuses
	}))
}, null, 2));
if (!report.passed) process.exitCode = 1;
