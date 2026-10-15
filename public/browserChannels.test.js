import test from 'node:test';
import assert from 'node:assert/strict';

import { BROWSER_VERSIONS, BROWSER_CHANNELS, channelFor } from './browserChannels.js';

test('client channel ladders mirror the server declarations', () => {
	assert.deepEqual(BROWSER_CHANNELS.chrome, ['canary', 'dev', 'beta', 'stable']);
	assert.deepEqual(BROWSER_CHANNELS.edge, ['canary', 'dev', 'beta', 'stable']);
	assert.deepEqual(BROWSER_CHANNELS.firefox, ['nightly', 'beta', 'stable']);
	assert.deepEqual(BROWSER_CHANNELS.brave, ['nightly', 'beta', 'stable']);
	assert.deepEqual(BROWSER_CHANNELS.opera, ['beta', 'stable']);
	assert.deepEqual(BROWSER_CHANNELS.safari, ['stable']);
	assert.deepEqual(BROWSER_CHANNELS.duckduckgo, ['stable']);
	for (const [code, ladder] of Object.entries(BROWSER_CHANNELS)) {
		assert.equal(ladder.at(-1), 'stable', `${code} ends stable`);
		if (code !== 'safari') assert.ok(BROWSER_VERSIONS[code], `${code} has version list`);
	}
});

test('channelFor labels by position and degrades unknowns to stable', () => {
	const chrome = BROWSER_VERSIONS.chrome;
	assert.equal(channelFor('chrome', chrome.at(-1)), 'canary');
	assert.equal(channelFor('chrome', chrome.at(-2)), 'dev');
	assert.equal(channelFor('chrome', chrome.at(-3)), 'beta');
	assert.equal(channelFor('chrome', chrome.at(-4)), 'stable');
	assert.equal(channelFor('chrome', chrome[0]), 'stable');
	assert.equal(channelFor('chrome', '999'), 'stable');
	assert.equal(channelFor('netscape', '5'), 'stable');
	assert.equal(channelFor('safari', '26'), 'stable');
});
