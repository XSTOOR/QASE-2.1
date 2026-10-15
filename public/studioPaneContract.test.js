import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [markup, behavior, styles] = await Promise.all([
	readFile(new URL('./index.html', import.meta.url), 'utf8'),
	readFile(new URL('./studioMode.js', import.meta.url), 'utf8'),
	readFile(new URL('./studio-embed.css', import.meta.url), 'utf8')
]);

test('Studio context exposes an accessible vertical separator with bounded values', () => {
	assert.match(markup, /id="studio-context-resizer"[^>]+role="separator"[^>]+tabindex="0"/s);
	assert.match(markup, /aria-orientation="vertical"/);
	assert.match(markup, /aria-valuemin="220"[^>]+aria-valuemax="340"[^>]+aria-valuenow="280"/s);
});

test('context width and open state use local Studio preferences with safe recovery', () => {
	assert.match(behavior, /qase\.studio\.contextState/);
	assert.match(behavior, /qase\.studio\.contextWidth/);
	assert.match(behavior, /minimum: 220, default: 280, maximum: 340/);
	assert.match(behavior, /Number\.isFinite\(parsed\).*parsed >= contextWidth\.minimum.*parsed <= contextWidth\.maximum/s);
	assert.match(behavior, /contextPreference.*=== 'collapsed' \? 'collapsed' : 'expanded'/);
});

test('pointer resizing captures input, prevents selection glitches, and persists the final width', () => {
	for (const eventName of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
		assert.match(behavior, new RegExp(`addEventListener\\('${eventName}'`));
	}
	assert.match(behavior, /setPointerCapture/);
	assert.match(behavior, /matchMedia\('\(min-width: 1101px\)'\)/);
	assert.match(styles, /data-studio-resizing="true"[\s\S]*user-select: none/);
});

test('keyboard resizing supports small and large steps plus both bounds', () => {
	assert.match(behavior, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
	assert.match(behavior, /event\.shiftKey \? 24 : 8/);
	assert.match(behavior, /setContextWidth\(nextWidth, true\)/);
});

test('collapsed context releases its grid tracks and desktop widths stay bounded', () => {
	assert.match(styles, /--studio-context-width: 280px/);
	assert.match(styles, /grid-template-columns: 64px var\(--studio-context-width\) 7px minmax\(0, 1fr\)/);
	assert.match(styles, /\.studio-tool-workspace \{[\s\S]*grid-column: 4;/);
	assert.match(styles, /data-studio-context="collapsed"[\s\S]*grid-template-columns: 64px 0 0 minmax\(0, 1fr\)/);
	assert.match(styles, /max-width: 1280px[\s\S]*grid-template-columns: 56px var\(--studio-context-width\) 6px minmax\(0, 1fr\)/);
});

test('responsive and standalone layouts do not expose the desktop resize handle', () => {
	assert.match(styles, /\.studio-context-resizer,[\s\S]*\.studio-tool-header \{\s*display: none;/);
	assert.match(styles, /max-width: 1100px[\s\S]*\.studio-context-resizer \{\s*display: none;/);
	assert.match(behavior, /if \(!enabled\) return;/);
});
