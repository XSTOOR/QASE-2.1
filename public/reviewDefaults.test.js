import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultReviewEnvironment } from './reviewDefaults.js';

test('review default requires explicit availability and prefers a desktop Chrome profile', () => {
	const envs = [
		{ envId: 'phone', deviceType: 'mobile', browser: 'Chrome', availability: 'AVAILABLE' },
		{ envId: 'unverified', deviceType: 'desktop', browser: 'Chrome' },
		{ envId: 'busy', deviceType: 'desktop', browser: 'Chrome', availability: 'AVAILABLE' },
		{ envId: 'edge', deviceType: 'desktop', browser: 'Edge', availability: 'AVAILABLE' },
		{ envId: 'chrome', deviceType: 'desktop', browser: 'Chrome', availability: 'AVAILABLE' }
	];
	assert.equal(defaultReviewEnvironment(envs, new Map([['busy', { status: 'UNAVAILABLE' }]])).envId, 'chrome');
	assert.equal(defaultReviewEnvironment(envs.slice(0, 2)), null);
	assert.equal(defaultReviewEnvironment([{ ...envs[4], active: false }]), null);
	assert.equal(defaultReviewEnvironment([envs[3]]).envId, 'edge');
});
