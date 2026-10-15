import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Phase 22 · persisted evidence artifacts.
 *
 * Every screenshot / video / console-log capture is stored under
 * `.qase/artifacts/<runId>/` with a JSON sidecar carrying the full
 * environment + EXECUTION LEVEL metadata, so no artifact can be mistaken
 * for real-device evidence unless it genuinely is:
 *
 *   { artifactId, type, capturedAt, sessionId, executionLevel,
 *     executionProvider, device, os, osVersion, browser, browserVersion,
 *     viewport, fileName, bytes, contentType }
 *
 * The label always comes from the run's RECORDED runtime facts
 * (session.executionLevel / runtimeFacts.executionLevel), never from the
 * level the user requested.
 */

const ARTIFACT_ROOT = () => path.resolve(process.env.QASE_ARTIFACT_DIR || path.join(process.cwd(), '.qase', 'artifacts'));

const TYPE_BY_EXTENSION = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webm: 'video/webm',
	mp4: 'video/mp4',
	json: 'application/json',
	txt: 'text/plain',
	log: 'text/plain'
};

function safeId(id) {
	// Session ids are server-generated UUIDs; reject anything path-like.
	return typeof id === 'string' && id !== '.' && id !== '..' && /^[A-Za-z0-9-_.]+$/.test(id) ? id : null;
}

/** Stamps honest execution metadata from the session's recorded state. */
	export function executionMetadataFor(session, bridgeExecution = null) {
	const recorded = session?.runtimeFacts?.executionLevel
		?? session?.executionLevel
		?? bridgeExecution?.level
		?? null;
	const provider = session?.runtimeFacts?.provider
		?? session?.executionProviderActual
		?? bridgeExecution?.provider
		?? null;
	// RT5 (#14757): the engine actually launched also travels with the stamp.
	const launchedEngineId = session?.runtimeFacts?.launchedEngineId
		?? bridgeExecution?.launchedEngineId
		?? null;
	return { executionLevel: recorded, executionProvider: provider, launchedEngineId };
}

export function createArtifactStore({ root = ARTIFACT_ROOT, now = () => Date.now() } = {}) {
	// RT5 (#14757): root is resolved ONCE at store creation (a literal path
	// or a factory function) — the store then owns a fixed root, so multiple
	// stores in one process stay isolated and every operation targets the
	// same directory. (Previously the injected root was silently ignored and
	// all stores shared the cwd default — tests passed only via accidental
	// accumulation across runs.)
	const resolvedRoot = typeof root === 'function' ? root() : root;
	const directoryFor = (sessionId) => path.join(resolvedRoot, sessionId);
	function writeSidecar(dir, meta) {
		const file = path.join(dir, `${meta.artifactId}.json`);
		const temporary = `${file}.${crypto.randomUUID()}.tmp`;
		try {
			fs.writeFileSync(temporary, JSON.stringify(meta, null, 2), { flag: 'wx', mode: 0o600 });
			fs.renameSync(temporary, file);
		} finally {
			fs.rmSync(temporary, { force: true });
		}
	}

	function readSidecar(dir, artifactId) {
		const sidecarPath = path.join(dir, `${artifactId}.json`);
		if (!fs.existsSync(sidecarPath)) return null;
		try {
			const meta = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
			if (meta?.artifactId !== artifactId || meta.sessionId !== path.basename(dir)
				|| typeof meta.fileName !== 'string' || !meta.fileName
				|| path.basename(meta.fileName) !== meta.fileName || /[\\/]/.test(meta.fileName)
				|| ['.', '..'].includes(meta.fileName) || typeof meta.contentType !== 'string'
				|| !Number.isFinite(meta.bytes) || typeof meta.capturedAt !== 'string') return null;
			return meta;
		} catch {
			return null;
		}
	}

	function guessContentType(fileName) {
		const ext = fileName.split('.').pop()?.toLowerCase();
		return TYPE_BY_EXTENSION[ext] ?? 'application/octet-stream';
	}

	return {
		/**
		 * Stores one artifact for a run and stamps execution metadata.
		 * `bytes` may be a Buffer or base64 string (data: URLs tolerated).
		 */
		save(session, { type, fileName, bytes, environment = null, bridgeExecution = null, label = null }) {
			const sessionId = safeId(session?.id);
			if (!sessionId) throw new Error('A valid session id is required.');
			if (!bytes || (Buffer.isBuffer(bytes) && bytes.length === 0)) {
				throw new Error('Artifact bytes are required.');
			}
			const dir = directoryFor(sessionId);
			fs.mkdirSync(dir, { recursive: true });

			let artifactId;
			do { artifactId = `ART-${crypto.randomBytes(4).toString('hex').toUpperCase()}`; }
			while (fs.existsSync(path.join(dir, `${artifactId}.json`)));
			const safeName = path.basename(fileName ?? `artifact-${artifactId}`);
			const storedName = `${artifactId}-${safeName}`;
			const buffer = Buffer.isBuffer(bytes)
				? bytes
				: Buffer.from(String(bytes).replace(/^data:[^,]*,/, ''), 'base64');
			fs.writeFileSync(path.join(dir, storedName), buffer, { flag: 'wx', mode: 0o600 });

			const env = environment ?? session?.environmentSnapshot ?? null;
			const execution = executionMetadataFor(session, bridgeExecution);
			const meta = {
				artifactId,
				type: type ?? 'screenshot',
				label: label ?? null,
				fileName: storedName,
				originalFileName: safeName,
				bytes: buffer.length,
				contentType: guessContentType(safeName),
				capturedAt: new Date(now()).toISOString(),
				sessionId,
				environmentId: env?.envId ?? null,
				device: env?.device ?? env?.deviceLabel ?? null,
				os: env?.os ?? env?.platform ?? null,
				osVersion: env?.osVersion ?? null,
				// RT5 (#14757, reviewer WARN fix): browser identity prefers the
				// RUNTIME-DETECTED truth (branded binary actually launched +
				// its detected version, and the engine that ran) over the
				// catalog/environment snapshot label — an artifact must state
				// what really executed, not what was requested.
				browser: session?.runtimeFacts?.brandedBinary?.brand ?? env?.browser ?? null,
				browserVersion: session?.runtimeFacts?.brandedBinary?.detectedVersion ?? env?.browserVersion ?? null,
				launchedEngine: session?.runtimeFacts?.launchedEngineId ?? execution.launchedEngineId ?? null,
				observedUserAgent: session?.runtimeFacts?.userAgent ?? null,
				viewport: session?.runtimeFacts?.viewport ?? env?.screenResolution ?? null,
				executionLevel: execution.executionLevel,
				executionProvider: execution.executionProvider,
				// Phase D3: attestation travels with the evidence so every
				// artifact header can show device/OS/browser/runtime session.
				...(session?.runtimeFacts?.attestation ? { attestation: session.runtimeFacts.attestation } : {}),
				...((session?.deviceSessionId ?? session?.runtimeFacts?.runtimeSessionId) ? {
					runtimeSessionId: session?.deviceSessionId ?? session?.runtimeFacts?.runtimeSessionId
				} : {}),
				// Evidence header line: "<EXEC TYPE> · device · OS · browser · Runtime RT-XXXX"
				evidenceHeader: [
					execution.executionLevel === 'REAL_DEVICE' ? 'REAL DEVICE'
						: execution.executionLevel === 'VIRTUAL_DEVICE' ? 'VIRTUAL DEVICE'
						: execution.executionLevel === 'SIMULATED' ? 'SIMULATED' : null,
					env?.device ?? env?.deviceLabel ?? null,
					[env?.os ?? env?.platform, env?.osVersion].filter(Boolean).join(' ') || null,
					[env?.browser, env?.browserVersion].filter(Boolean).join(' ') || null,
					(session?.deviceSessionId ?? session?.runtimeFacts?.runtimeSessionId)
						? `Runtime ${session?.deviceSessionId ?? session?.runtimeFacts?.runtimeSessionId}` : null
				].filter(Boolean).join(' · ') || null,
				...((session?.permissionScenario ?? env?.permissionScenario) ? {
					permissionScenario: session?.permissionScenario ?? env?.permissionScenario
				} : {})
			};
			writeSidecar(dir, meta);
			return meta;
		},

		/** Lists a run's artifacts (metadata only, newest first). */
		list(sessionId) {
			const id = safeId(sessionId);
			if (!id) return [];
			const dir = directoryFor(id);
			if (!fs.existsSync(dir)) return [];
			return fs.readdirSync(dir)
				.filter(name => /^ART-[A-F0-9]{8}\.json$/.test(name))
				.map(name => readSidecar(dir, name.slice(0, -5)))
				.filter(Boolean)
				.sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
		},

		/** Returns { meta, bytes } or null when unknown. */
		get(sessionId, artifactId) {
			const id = safeId(sessionId);
			const art = safeId(artifactId);
			if (!id || !art) return null;
			const dir = directoryFor(id);
			const meta = readSidecar(dir, art);
			if (!meta) return null;
			const filePath = path.join(dir, meta.fileName);
			if (!fs.existsSync(filePath)) return null;
			return { meta, bytes: fs.readFileSync(filePath) };
		},

		/** Removes every artifact for a run (used on run deletion). */
		removeAll(sessionId) {
			const id = safeId(sessionId);
			if (!id) return false;
			const dir = directoryFor(id);
			if (!fs.existsSync(dir)) return false;
			fs.rmSync(dir, { recursive: true, force: true });
			return true;
		}
	};
}
