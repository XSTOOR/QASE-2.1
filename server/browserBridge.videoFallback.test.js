import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createContextWithVideoFallback,
	isVideoRecordingDependencyError
} from './browserBridge.js';

const FFMPEG_ERROR = new Error(
	'browserContext.newPage: Executable doesn\'t exist at /home/coder/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux'
);

function page() {
	return { close: async () => undefined };
}

test('recognizes the hosted Playwright missing-FFmpeg failure', () => {
	assert.equal(isVideoRecordingDependencyError(FFMPEG_ERROR), true);
	assert.equal(isVideoRecordingDependencyError(new Error('Browser closed unexpectedly')), false);
});

test('late FFmpeg failure recreates the context without video before agent work starts', async () => {
	const calls = [];
	let firstClosed = false;
	const browser = {
		async newContext(options) {
			calls.push(structuredClone(options));
			if (calls.length === 1) {
				return {
					newPage: async () => { throw FFMPEG_ERROR; },
					close: async () => { firstClosed = true; }
				};
			}
			return { newPage: async () => page(), close: async () => undefined };
		}
	};

	const result = await createContextWithVideoFallback(browser, {
		viewport: { width: 1440, height: 900 },
		recordVideo: { dir: '/tmp/qase-video', size: { width: 1440, height: 900 } }
	});

	assert.equal(firstClosed, true, 'the unusable recording context is discarded');
	assert.equal(calls.length, 2);
	assert.ok(calls[0].recordVideo);
	assert.equal(calls[1].recordVideo, undefined);
	assert.equal(result.videoActive, false);
	assert.match(result.fallbackReason, /ffmpeg-1011/);
	assert.ok(result.probePage, 'the replacement context proves it can create a page');
});

test('a remembered host failure skips video without repeating the broken attempt', async () => {
	const calls = [];
	const browser = {
		async newContext(options) {
			calls.push(structuredClone(options));
			return { newPage: async () => page(), close: async () => undefined };
		}
	};
	const reason = 'FFmpeg is unavailable on this runner.';
	const result = await createContextWithVideoFallback(browser, {
		recordVideo: { dir: '/tmp/qase-video' }
	}, { skipVideoReason: reason });

	assert.equal(calls.length, 1);
	assert.equal(calls[0].recordVideo, undefined);
	assert.equal(result.videoActive, false);
	assert.equal(result.fallbackReason, reason);
});

test('non-video page startup failures remain visible', async () => {
	let closed = false;
	const browser = {
		async newContext() {
			return {
				newPage: async () => { throw new Error('Browser process crashed'); },
				close: async () => { closed = true; }
			};
		}
	};
	await assert.rejects(
		createContextWithVideoFallback(browser, { recordVideo: { dir: '/tmp/qase-video' } }),
		/Browser process crashed/
	);
	assert.equal(closed, true);
});
