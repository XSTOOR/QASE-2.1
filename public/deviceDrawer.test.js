import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	platformForCategory,
	groupModelsByCategory,
	filterDrawerSections,
	selectionCountLabel,
	chipLabel,
	RUNTIME_PROFILES
} from '../public/deviceDrawer.js';

describe('deviceDrawer helpers', () => {
	test('platformForCategory maps catalog category names to drawer tabs', () => {
		assert.equal(platformForCategory('Samsung'), 'android');
		assert.equal(platformForCategory('Google Pixel'), 'android');
		assert.equal(platformForCategory('Nothing'), 'android');
		assert.equal(platformForCategory('Windows Laptop'), 'windows');
		assert.equal(platformForCategory('Windows Tablet'), 'windows');
		assert.equal(platformForCategory('iPhone'), 'apple');
		assert.equal(platformForCategory('Mac'), 'apple');
		assert.equal(platformForCategory(''), 'apple');
	});

	test('groupModelsByCategory groups models under their category display name', () => {
		const categories = [
			{ id: 'cat-samsung', display_name: 'Samsung' },
			{ id: 'cat-winlap', display_name: 'Windows Laptop' }
		];
		const models = [
			{ id: 'galaxy-s24', display_name: 'Galaxy S24', category_id: 'cat-samsung' },
			{ id: 'win-laptop', display_name: 'Windows Laptop', category_id: 'cat-winlap' },
			{ id: 'galaxy-a55', display_name: 'Galaxy A55', category_id: 'cat-samsung' }
		];
		const groups = groupModelsByCategory(models, categories);
		assert.deepEqual(groups.map((g) => g.category), ['Samsung', 'Windows Laptop']);
		assert.equal(groups[0].models.length, 2);
		assert.equal(groups[1].models.length, 1);
	});

	test('filterDrawerSections filters by tab and search, dropping empty sections', () => {
		const sections = [
			{ category: 'Samsung', models: [{ id: 'galaxy-s24', display_name: 'Galaxy S24' }, { id: 'galaxy-a55', display_name: 'Galaxy A55' }] },
			{ category: 'iPhone', models: [{ id: 'iphone-16-pro', display_name: 'iPhone 16 Pro' }] },
			{ category: 'Windows Laptop', models: [{ id: 'win-laptop', display_name: 'Windows Laptop' }] }
		];
		const apple = filterDrawerSections(sections, { tab: 'apple', search: '' });
		assert.equal(apple.length, 1);
		assert.equal(apple[0].category, 'iPhone');
		const pixelSearch = filterDrawerSections(sections, { tab: 'all', search: 'pixel' });
		assert.equal(pixelSearch.length, 0); // no Pixel models in this fixture
		const s24 = filterDrawerSections(sections, { tab: 'android', search: 's24' });
		assert.equal(s24.length, 1);
		assert.equal(s24[0].models[0].id, 'galaxy-s24');
		const windows = filterDrawerSections(sections, { tab: 'windows', search: '' });
		assert.equal(windows.length, 1);
	});

	test('selectionCountLabel pluralizes', () => {
		assert.equal(selectionCountLabel(1), '1 environment selected');
		assert.equal(selectionCountLabel(7), '7 environments selected');
	});

	test('chipLabel composes device, OS and browser from env or a friendly default', () => {
		assert.equal(chipLabel(null), 'none yet');
		assert.equal(
			chipLabel({ device: 'Galaxy S24', os: 'android', osVersion: '15', browser: 'chrome', browserVersion: '141' }),
			'Galaxy S24 — android 15 — chrome 141'
		);
		assert.equal(
			chipLabel({ device: 'iPhone 16 Pro', osLabel: 'iOS 18.3', browserLabel: 'Safari 18.3' }),
			'iPhone 16 Pro — iOS 18.3 — Safari 18.3'
		);
	});

	test('RUNTIME_PROFILES never claims real hardware or unsupported capabilities', () => {
		// Every catalog platform has a profile.
		for (const platform of ['ios', 'ipados', 'macos', 'android', 'windows']) {
			assert.ok(RUNTIME_PROFILES[platform], `${platform} profile exists`);
		}
		// iOS screen share is honestly limited — never "supported".
		assert.notEqual(RUNTIME_PROFILES.ios.media.screenShare.supported, true);
		assert.notEqual(RUNTIME_PROFILES.android.media.screenShare.supported, true);
		// Phone platforms are touch-first; desktops are mouse+keyboard.
		assert.ok(RUNTIME_PROFILES.ios.input.includes('touch'));
		assert.ok(!RUNTIME_PROFILES.macos.input.includes('touch'));
	});
});
