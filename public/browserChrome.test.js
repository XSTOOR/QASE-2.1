import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserBrand, chromeViewModel } from './browserChrome.js';

test('brand metadata covers every browser key', () => {
	assert.equal(browserBrand('safari').name, 'Safari');
	assert.equal(browserBrand('chrome').name, 'Chrome');
	assert.equal(browserBrand('firefox').name, 'Firefox');
	assert.equal(browserBrand('edge').name, 'Edge');
	assert.equal(browserBrand('opera').name, 'Opera');
	assert.equal(browserBrand('brave').name, 'Brave');
	assert.equal(browserBrand('duckduckgo').name, 'DuckDuckGo');
	assert.equal(browserBrand('other').name, 'Browser');
	assert.equal(browserBrand('unknown-thing').name, 'Browser');
	// Each brand is visually distinct.
	const colors = new Set(Object.values({ s: browserBrand('safari'), c: browserBrand('chrome'), f: browserBrand('firefox'), e: browserBrand('edge') }).map((b) => b.color));
	assert.equal(colors.size, 4);
});

test('chrome view-model derives host, security and nav glyphs from the live frame', () => {
	const vm = chromeViewModel({ browserKey: 'chrome', url: 'https://meeting.drytis.dev/room/1', title: 'Meeting' });
	assert.equal(vm.brand.name, 'Chrome');
	assert.equal(vm.url, 'meeting.drytis.dev');
	assert.equal(vm.secure, true);
	assert.deepEqual(vm.navGlyphs, ['←', '→', '↻']);
});

test('insecure and empty urls stay honest', () => {
	const http = chromeViewModel({ browserKey: 'safari', url: 'http://example.test/' });
	assert.equal(http.secure, false);
	assert.equal(http.url, 'example.test');
	const idle = chromeViewModel({ browserKey: 'safari', url: 'about:blank' });
	assert.equal(idle.url, 'about:blank');
	assert.equal(idle.secure, false);
	const none = chromeViewModel({ browserKey: 'firefox' });
	assert.equal(none.url, 'about:blank');
});
