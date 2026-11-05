import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSqaAcceptanceResult, isolatedSqaEnvironment, SQA_TEST_BROWSERS } from './sqa-test-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'test-results', 'sqa-release', `${Date.now()}`);
await mkdir(path.join(directory, 'unit-runtime'), { recursive: true });
const report = {
	schema: 1, status: 'running', startedAt: new Date().toISOString(),
	platform: process.platform, architecture: process.arch, node: process.version,
	scope: 'SQA local acceptance; not production deployment or live model qualification',
	checks: []
};
async function sourceIdentity() {
	const files = [];
	async function collect(relative) {
		for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			const next = path.posix.join(relative, entry.name);
			if (entry.isDirectory()) await collect(next);
			else if (entry.isFile()) files.push(next);
		}
	}
	for (const entry of ['server', 'public', 'scripts', '.github/workflows']) await collect(entry);
	files.push('package.json', 'package-lock.json');
	const hash = createHash('sha256');
	for (const file of files.sort()) hash.update(`${file}\0`).update(await readFile(path.join(root, file))).update('\0');
	const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).stdout?.trim() || 'unavailable';
	return { sha256: hash.digest('hex'), files: files.length, commit: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current') };
}
async function save() {
	await writeFile(path.join(directory, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
}
async function run(name, args, cwd = root) {
	console.log(`SQA release check: ${name}`);
	const started = Date.now();
	const logPath = path.join(directory, `${name}.log`);
	const log = createWriteStream(logPath);
	const child = spawn(process.execPath, args, { cwd, windowsHide: true, env: isolatedSqaEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
	child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 300_000);
	const code = await new Promise((resolve, reject) => {
		child.once('error', reject); child.once('close', resolve);
	}).finally(() => clearTimeout(timer));
	await new Promise(resolve => log.end(resolve));
	const check = { name, status: code === 0 && !timedOut ? 'passed' : 'failed', exitCode: code, durationMs: Date.now() - started, log: path.basename(logPath), timedOut };
	report.checks.push(check); await save();
	if (check.status !== 'passed') throw new Error(`${name} failed; inspect ${logPath}`);
	return check;
}

try {
	report.source = await sourceIdentity(); await save();
	const tests = [];
	for (const folder of ['server', 'public']) {
		for (const file of (await readdir(path.join(root, folder))).sort()) {
			if (/^sqa.*\.test\.js$/.test(file)) tests.push(path.join(root, folder, file));
		}
	}
	tests.push(path.join(root, 'server', 'browserEngines.test.js'), path.join(root, 'server', 'app.test.js'));
	const unit = await run('contracts', ['--test', '--test-concurrency=2', '--test-reporter=tap', ...tests], path.join(directory, 'unit-runtime'));
	const tap = await readFile(path.join(directory, unit.log), 'utf8');
	unit.tests = Object.fromEntries(['tests', 'pass', 'fail', 'skipped', 'cancelled'].map(name => [name, Number(tap.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? NaN)]));
	if (!Number.isFinite(unit.tests.tests) || !unit.tests.pass || unit.tests.fail || unit.tests.cancelled || unit.tests.skipped) throw new Error('SQA contract checks must report passing tests without skips.');
	for (const browser of SQA_TEST_BROWSERS) {
		for (const kind of ['startup', 'launch', 'evidence']) {
			const output = path.join(directory, `${browser}-${kind}`);
			await mkdir(output, { recursive: true });
			const args = [path.join(root, 'scripts', `test-sqa-${kind}.mjs`), '--browser', browser, '--output-dir', output];
			if (kind === 'startup') args.push('--isolated');
			const check = await run(`${browser}-${kind}`, args);
			const result = JSON.parse(await readFile(path.join(output, 'result.json'), 'utf8'));
			assertSqaAcceptanceResult(result, browser, kind);
			check.result = result; await save();
		}
	}
	const after = await sourceIdentity();
	if (after.sha256 !== report.source.sha256) throw new Error('Source files changed during acceptance; rerun against one stable version.');
	report.status = 'passed';
} catch (error) {
	report.status = 'failed'; report.error = error.message; process.exitCode = 1;
} finally {
	report.finishedAt = new Date().toISOString(); await save();
	console.log(JSON.stringify({ status: report.status, directory, error: report.error }, null, 2));
}
