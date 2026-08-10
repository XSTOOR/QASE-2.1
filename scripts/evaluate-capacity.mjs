import { readFile } from 'node:fs/promises';
import { evaluateCapacityEvidence } from '../server/capacityEvidence.js';

async function document(filePath, label) {
	if (!filePath) throw new TypeError(`${label} path is required.`);
	const data = await readFile(filePath);
	if (data.byteLength > 1_000_000) throw new TypeError(`${label} exceeds 1 MB.`);
	try { return JSON.parse(data.toString('utf8')); }
	catch { throw new TypeError(`${label} is not valid JSON.`); }
}

const evidence = await document(process.argv[2], 'Capacity evidence');
const policy = await document(process.argv[3], 'Capacity policy');
const report = evaluateCapacityEvidence(evidence, policy);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
