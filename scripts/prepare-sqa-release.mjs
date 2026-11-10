import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { RELEASE_DIRECTORIES, RELEASE_FILES, writeSourceManifest } from './release-source.mjs';
import { verifyRelease } from './verify-release.mjs';

// Prepare a reviewable snapshot, without normalizing the working tree or
// replacing its historical production manifest and release identity.
const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { 'output-dir': { type: 'string' }, 'release-id': { type: 'string' } } });
if (values['release-id'] && !/^[a-z0-9][a-z0-9._-]{0,100}$/i.test(values['release-id'])) throw new Error('Release ID must be a short filename-safe identifier.');
const output = path.resolve(values['output-dir'] ?? path.join(root, 'test-results', 'sqa-candidates', String(Date.now()), 'source'));
if (output === path.resolve(root) || fs.existsSync(output)) throw new Error('Choose a new, empty output directory for the SQA candidate.');
// An output inside an inventoried source directory would recursively copy itself.
for (const directory of RELEASE_DIRECTORIES) {
	const source = path.resolve(root, directory);
	const relative = path.relative(source, output);
	if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Candidate output must be outside inventoried source directories.');
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.mkdirSync(output);
for (const item of [...RELEASE_DIRECTORIES, ...RELEASE_FILES]) fs.cpSync(path.join(root, item), path.join(output, item), { recursive: true, dereference: false });
function normalize(directory) {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error('Candidate source may not contain symbolic links.');
		if (entry.isDirectory()) normalize(file);
		else {
			const bytes = fs.readFileSync(file), text = bytes.toString('utf8');
			if (!bytes.includes(0) && Buffer.from(text, 'utf8').equals(bytes) && text.includes('\r\n')) fs.writeFileSync(file, text.replaceAll('\r\n', '\n'));
		}
	}
}
normalize(output);
const index = fs.readFileSync(path.join(output, 'public', 'index.html'), 'utf8');
const uiVersion = [...index.matchAll(/[?&]v=(\d{8}-\d+)\b/g)].map(match => match[1]).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1);
if (!uiVersion) throw new Error('Candidate UI version is missing.');
const releaseFile = path.join(output, 'public', 'release.json');
const old = JSON.parse(fs.readFileSync(releaseFile, 'utf8'));
const releaseId = values['release-id'] ?? `qase-sqa-${uiVersion}-candidate`;
const release = { ...old, releaseId, uiVersion, source: 'SQA candidate based on codex/hybrid-production-readiness; local review snapshot, not production activation' };
fs.writeFileSync(releaseFile, `${JSON.stringify(release, null, 2)}\n`);
const dockerFile = path.join(output, 'Dockerfile');
const docker = fs.readFileSync(dockerFile, 'utf8');
if (!docker.includes(`ARG QASE_RELEASE_ID=${old.releaseId}`)) throw new Error('Unexpected Docker release identity.');
fs.writeFileSync(dockerFile, docker.replace(`ARG QASE_RELEASE_ID=${old.releaseId}`, `ARG QASE_RELEASE_ID=${releaseId}`));
const candidateNote = `# SQA candidate handoff\n\nRelease: \`${releaseId}\`. UI: \`${uiVersion}\`.\n\nThis isolated snapshot contains the SQA work from Push-SQA on the corrected hybrid\nproduction-readiness base. It includes bounded browser smoke checks, evidence-gated\nassessment, human review and immutable versions, authenticated evidence inspection,\nshared report traceability and three-engine acceptance.\n\nVerify SOURCE_MANIFEST.json before use. Qualification results are supplied separately;\na verified manifest identifies bytes and does not establish production readiness.\nFull repository verification, SQA acceptance, hosted CI and production-image checks\nremain mandatory. Deploy only after review and explicit deployment authorization.\nDo not import developer state or credentials.\n\nThe original production handoff follows for historical context. Its old release\nidentity and UI references describe that earlier snapshot.\n\n---\n\n`;
for (const file of ['README.md', 'RELEASE_NOTES.md', 'DEPLOYMENT_PROMPT.md']) fs.writeFileSync(path.join(output, file), candidateNote + fs.readFileSync(path.join(output, file), 'utf8'));
writeSourceManifest(output);
const verified = verifyRelease(output);
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout?.trim();
const result = { status: 'prepared', releaseId, uiVersion, files: verified.files, sourceCommit: commit, containsUncommittedWork: true, output, preparedAt: new Date().toISOString() };
fs.writeFileSync(path.join(path.dirname(output), 'candidate.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
