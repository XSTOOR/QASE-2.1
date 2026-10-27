import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyRelease } from './verify-release.mjs';
import { RELEASE_DIRECTORIES, RELEASE_FILES } from './release-source.mjs';

/**
 * Builds a zip of the source that is safe to hand to somebody else.
 *
 * The exclusions are the point: `.env` and `.qase/config.json` hold an API key,
 * `.qase/sessions.json` holds every site that has been tested. Zipping the
 * folder as it stands still ships sensitive local state.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(root, process.argv[2] ?? 'qase-share.zip');
if (!output.toLowerCase().endsWith('.zip')) throw new Error('Package output must be a .zip file.');

const EXCLUDED_ROOTS = new Set([
	'node_modules', '.qase', '.git', '.claude', '.idea', '.vscode',
	'coverage', 'test-results', 'playwright-report', 'dist', 'tmp', 'temp'
]);
const EXCLUDED_EXTENSIONS = new Set(['.zip', '.log', '.pem', '.key', '.p12', '.pfx']);
const INCLUDED_DIRECTORIES = RELEASE_DIRECTORIES;
const INCLUDED_FILES = RELEASE_FILES;

fs.rmSync(output, { force: true });

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-package-'));
const staging = path.join(temporaryRoot, 'source');
let listing;

try {
	fs.mkdirSync(staging, { recursive: true });
	for (const directory of INCLUDED_DIRECTORIES) {
		const source = path.join(root, directory);
		if (!fs.existsSync(source)) {
			throw new Error(`Refusing to package — source directory is missing: ${directory}`);
		}
		fs.cpSync(source, path.join(staging, directory), { recursive: true });
	}
	for (const file of INCLUDED_FILES) {
		const source = path.join(root, file);
		if (!fs.existsSync(source)) {
			throw new Error(`Refusing to package — source file is missing: ${file}`);
		}
		fs.copyFileSync(source, path.join(staging, file));
	}
	const entries = [];
	function collect(directory) {
		for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
			const full = path.join(directory, item.name);
			if (item.isSymbolicLink()) throw new Error('Refusing to package symbolic links.');
			if (item.isDirectory()) collect(full);
			else {
				// Match .gitattributes so Linux Git checkouts preserve manifest hashes.
				let bytes = fs.readFileSync(full);
				const text = bytes.toString('utf8');
				if (!bytes.includes(0) && Buffer.from(text, 'utf8').equals(bytes)) {
					bytes = Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8');
					fs.writeFileSync(full, bytes);
				}
				entries.push({ path: path.relative(staging, full).replaceAll('\\', '/'), sha256: createHash('sha256').update(bytes).digest('hex') });
			}
		}
	}
	collect(staging);
	const release = JSON.parse(fs.readFileSync(path.join(staging, 'public/release.json'), 'utf8'));
	fs.writeFileSync(path.join(staging, 'SOURCE_MANIFEST.json'), JSON.stringify({ schema: 1, releaseId: release.releaseId, files: entries.sort((a, b) => a.path.localeCompare(b.path)) }, null, 2) + '\n');
	verifyRelease(staging);

	if (process.platform === 'win32') {
		// Modern Windows ships bsdtar, which selects ZIP from the output suffix.
		execFileSync('tar', ['-a', '-c', '-f', output, '.'], { cwd: staging, stdio: 'inherit' });
		listing = execFileSync('tar', ['-t', '-f', output], { cwd: staging, encoding: 'utf8' });
	} else {
		execFileSync('zip', ['-r', '-q', output, '.'], { cwd: staging, stdio: 'inherit' });
		listing = execFileSync('unzip', ['-Z1', output], { cwd: staging, encoding: 'utf8' });
	}
} catch (error) {
	fs.rmSync(output, { force: true });
	throw error;
} finally {
	const resolvedTemporaryRoot = path.resolve(temporaryRoot);
	if (path.dirname(resolvedTemporaryRoot) !== path.resolve(os.tmpdir())
		|| !path.basename(resolvedTemporaryRoot).startsWith('qase-package-')) {
		throw new Error('Refusing to remove an unexpected packaging temporary directory.');
	}
	fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

// Verify rather than trust: a leaked key is not something to find out about
// later, so the archive is read back and checked before it is handed over.
listing = listing
	.split('\n')
	.map(entry => entry.trim().replace(/^\.\//, '').replaceAll('\\', '/'))
	.filter(entry => entry && entry !== '.');

const leaked = listing.filter(entry => {
	const parts = entry.split('/');
	const name = path.basename(entry);
	return parts.some(part => EXCLUDED_ROOTS.has(part))
		|| name === '.env'
		|| (name.startsWith('.env.') && name !== '.env.example')
		|| EXCLUDED_EXTENSIONS.has(path.extname(name).toLowerCase());
});

if (leaked.length > 0) {
	fs.rmSync(output, { force: true });
	console.error('Refusing to package — these should not be in the archive:');
	for (const entry of leaked) {
		console.error(`  ${entry}`);
	}
	process.exit(1);
}

for (const required of [
	'package.json', 'package-lock.json', '.env.example', '.nvmrc', 'Dockerfile',
	'.github/workflows/verify.yml',
	'deploy/kubernetes/base/qase.yaml', 'deploy/kubernetes/base/migrations.yaml',
	'deploy/observability/service-monitors.yaml',
	'deploy/observability/prometheus-rules.yaml',
	'deploy/observability/grafana-dashboard.json',
	'deploy/qualification/capacity-evidence.schema.json',
	'deploy/qualification/resilience-evidence.schema.json',
	'load/k6/control-plane-placement.js',
	'server/postgres/migrations/007_data_lifecycle.sql',
	'server/postgres/retentionRepository.js',
	'integrations/drytis/qaseClient.js',
	'integrations/drytis/protocol.js',
	'integrations/drytis/README.md',
	'scripts/data-governance.mjs',
	'SOURCE_MANIFEST.json', 'public/release.json', 'public/runCard.css', 'public/runCard.js',
	'DEPLOYMENT_PROMPT.md', 'RELEASE_NOTES.md', 'deploy/production/compose.yaml',
	'docs/enterprise-migration/phase-10-data-governance.md'
]) {
	if (!listing.includes(required)) {
		fs.rmSync(output, { force: true });
		throw new Error(`Refusing to package — required source file is missing: ${required}`);
	}
}

const size = (fs.statSync(output).size / 1024).toFixed(0);
console.log(`\n  ${path.basename(output)}  ${size} KB  ${listing.length} archive entries`);
console.log('  No API key, no run history, no node_modules.\n');
fs.writeFileSync(`${output}.sha256`, `${createHash('sha256').update(fs.readFileSync(output)).digest('hex')}  ${path.basename(output)}\n`);
console.log('  Read DEPLOYMENT_PROMPT.md; verify SOURCE_MANIFEST.json before building.\n');
