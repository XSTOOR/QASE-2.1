import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

// Import this before application modules: local stores and analytics capture
// their paths at module load, even when a fixture injects an in-memory store.
const originalDirectory = process.cwd();
const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'qase-unit-'));
process.chdir(directory);

after(() => {
	process.chdir(originalDirectory);
	if (path.dirname(directory) !== temporaryRoot || !path.basename(directory).startsWith('qase-unit-')) {
		throw new Error('Refusing to clean an unexpected test directory.');
	}
	fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
