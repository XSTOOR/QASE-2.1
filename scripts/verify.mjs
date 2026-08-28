import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Project verification entry point.
 *
 * This performs syntax checks, confirms private local state is ignored, scans
 * source files for a small set of high-confidence credential signatures, and
 * runs the existing test suite. It does not start Qase or open Chromium.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function relative(filePath) {
	return path.relative(root, filePath).replaceAll(path.sep, '/');
}

function filesUnder(directory, extensions) {
	const files = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const resolved = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...filesUnder(resolved, extensions));
		} else if (extensions.has(path.extname(entry.name))) {
			files.push(resolved);
		}
	}
	return files;
}

const required = [
	'package.json',
	'package-lock.json',
	'public/index.html',
	'server/index.js',
	'server/agent.js'
];

for (const candidate of required) {
	if (!fs.existsSync(path.join(root, candidate))) {
		failures.push(`Missing required file: ${candidate}`);
	}
}

const sourceFiles = [
	...filesUnder(path.join(root, 'server'), new Set(['.js'])),
	...filesUnder(path.join(root, 'public'), new Set(['.js'])),
	...filesUnder(path.join(root, 'scripts'), new Set(['.js', '.mjs'])),
	...filesUnder(path.join(root, 'integrations'), new Set(['.js', '.mjs'])),
	...filesUnder(path.join(root, 'load'), new Set(['.js', '.mjs']))
].sort();

for (const filePath of sourceFiles) {
	const check = spawnSync(process.execPath, ['--check', filePath], {
		cwd: root,
		encoding: 'utf8'
	});
	if (check.status !== 0) {
		failures.push(`Syntax check failed: ${relative(filePath)}\n${check.stderr.trim()}`);
	}
}

const secretSignatures = [
	{ name: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
	{ name: 'AWS access key', pattern: /\bAKIA[A-Z0-9]{16}\b/ },
	{ name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	{ name: 'provider-style secret key', pattern: /\bsk-[A-Za-z0-9_-]{24,}\b/ }
];

const scanFiles = [
	...sourceFiles,
	...filesUnder(path.join(root, 'server'), new Set(['.sql'])),
	...filesUnder(path.join(root, 'docs'), new Set(['.md'])),
	...filesUnder(path.join(root, 'deploy'), new Set(['.yaml', '.yml', '.json'])),
	path.join(root, 'package.json'),
	path.join(root, 'README.md'),
	path.join(root, '.env.example'),
	path.join(root, 'Dockerfile')
];

for (const filePath of scanFiles) {
	const content = fs.readFileSync(filePath, 'utf8');
	for (const signature of secretSignatures) {
		if (signature.pattern.test(content)) {
			failures.push(`Possible ${signature.name}: ${relative(filePath)}`);
		}
	}
}

const gitAvailable = spawnSync('git', ['--version'], { cwd: root, encoding: 'utf8' });
if (gitAvailable.status !== 0) {
	failures.push('Git is unavailable; private-path ignore rules could not be verified.');
} else {
	for (const privatePath of ['.env', '.qase/config.json', 'node_modules/package.json', 'qase-share.zip']) {
		const ignored = spawnSync('git', ['check-ignore', '--no-index', '--quiet', privatePath], {
			cwd: root,
			encoding: 'utf8'
		});
		if (ignored.status !== 0) {
			failures.push(`Private or generated path is not ignored: ${privatePath}`);
		}
	}
}

if (failures.length > 0) {
	console.error('\nBaseline verification failed:\n');
	for (const failure of failures) {
		console.error(`- ${failure}`);
	}
	process.exit(1);
}

console.log(`Syntax checks passed for ${sourceFiles.length} source files.`);
console.log('Private-path ignore checks passed.');
console.log('High-confidence source credential scan passed.');

const tests = filesUnder(path.join(root, 'server'), new Set(['.js']))
	.filter(filePath => filePath.endsWith('.test.js'))
	.sort();

const testRun = spawnSync(process.execPath, ['--test', ...tests], {
	cwd: root,
	stdio: 'inherit'
});

if (testRun.status !== 0) {
	process.exit(testRun.status ?? 1);
}

console.log('\nProject verification passed.');
