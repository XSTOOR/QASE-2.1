import 'dotenv/config';
import { runPlacementLoad } from '../server/deploymentChecks.js';

const report = await runPlacementLoad();
console.log(JSON.stringify({
	requests: report.requests,
	elapsedMs: Number(report.elapsedMs.toFixed(1)),
	requestsPerSecond: Number(report.requestsPerSecond.toFixed(1)),
	p50Ms: Number(report.p50Ms.toFixed(1)),
	p95Ms: Number(report.p95Ms.toFixed(1)),
	p99Ms: Number(report.p99Ms.toFixed(1)),
	statuses: report.statuses
}, null, 2));
if (Object.entries(report.statuses).some(([status]) => !status.startsWith('2'))) process.exitCode = 1;
