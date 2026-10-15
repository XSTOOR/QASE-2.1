import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'dotenv';
import { platformEnvironment } from '../server/platformEnvironment.js';

// Explicit opt-in: never search parent folders for secrets or copy their files.
const { values } = parseArgs({ options: { 'env-file': { type: 'string' } } });
if (values['env-file']) {
	const settings = parse(readFileSync(resolve(values['env-file']), 'utf8'));
	Object.assign(process.env, platformEnvironment(settings, process.env));
}
process.env.QASE_HOST ??= '127.0.0.1';
process.env.PORT ??= '5173';
process.env.QASE_RUN_STORE ??= 'local';
process.env.QASE_EXECUTION_MODE ??= 'local';
await import('../server/index.js');
