import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	DRYTIS_INTEGRATION_SCHEMA_VERSION,
	normalizeDrytisCreateRequest
} from './drytisIntegrationSchema.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const REVIEW_ID = '00000000-0000-4000-8000-000000000101';

function request(overrides = {}) {
	return {
		schemaVersion: DRYTIS_INTEGRATION_SCHEMA_VERSION,
		externalReviewId: REVIEW_ID,
		project: { id: PROJECT_ID, name: 'Studio project', revision: 'commit:abc123' },
		containerUrl: 'https://preview.drytis.example/',
		requestedChecks: { blackBox: true, whiteBox: false },
		...overrides
	};
}

test('Studio create contract accepts the canonical container URL and bounded project context', () => {
	const normalized = normalizeDrytisCreateRequest(request({
		projectContext: {
			description: 'A collaborative full-stack application.',
			applicationType: 'B2B SaaS',
			primaryLanguage: 'TypeScript',
			frameworks: ['React', 'Node.js', 'React'],
			environment: 'ephemeral-preview',
			defaultBranch: 'main'
		}
	}), PROJECT_ID);

	assert.equal(normalized.containerUrl, 'https://preview.drytis.example/');
	assert.equal(normalized.previewUrl, normalized.containerUrl);
	assert.deepEqual(normalized.projectContext.frameworks, ['React', 'Node.js']);
});

test('legacy previewUrl remains compatible while conflicting target aliases fail closed', () => {
	const legacy = request({ previewUrl: 'https://preview.drytis.example/' });
	delete legacy.containerUrl;
	assert.equal(normalizeDrytisCreateRequest(legacy, PROJECT_ID).containerUrl,
		'https://preview.drytis.example/');

	assert.throws(() => normalizeDrytisCreateRequest(request({
		previewUrl: 'https://other.drytis.example/'
	}), PROJECT_ID), error => error.code === 'invalid_preview_url');
});

test('project context is strict, bounded, and never accepts commands or arbitrary metadata', () => {
	assert.throws(() => normalizeDrytisCreateRequest(request({
		projectContext: { testCommand: 'npm test' }
	}), PROJECT_ID), error => error.code === 'unsupported_fields');
	assert.throws(() => normalizeDrytisCreateRequest(request({
		projectContext: { frameworks: Array.from({ length: 21 }, (_, index) => `framework-${index}`) }
	}), PROJECT_ID), error => error.code === 'invalid_request');
});
