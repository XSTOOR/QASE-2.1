import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { canonicalModeHash } from './modeIntegrity.js';

const limit = 512000;
export function storeResearchBody(content) {
	if (Buffer.byteLength(content) < 24000) return { content };
	const compressed = gzipSync(content).toString('base64');
	return compressed.length < Buffer.byteLength(content) ? { gzipBody: compressed } : { content };
}

export function verifiedResearchBody(source, runId) {
	if (!source || source.runId !== runId) return null;
	const { integrityHash, ...payload } = source;
	if (canonicalModeHash(payload) !== integrityHash) return null;
	try {
		const body = source.gzipBody === undefined ? source.content :
			gunzipSync(Buffer.from(source.gzipBody, 'base64'), {maxOutputLength:limit}).toString('utf8');
		if (typeof body !== 'string' || Buffer.byteLength(body) > limit ||
			createHash('sha256').update(body).digest('hex') !== source.contentHash) return null;
		return body;
	} catch { return null; }
}
