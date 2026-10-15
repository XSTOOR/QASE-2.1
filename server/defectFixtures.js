/**
 * Known-defect fixtures (#14650 NI02 Phase 2).
 *
 * A small registry of representative known defects. Each fixture:
 *   - mounts a demo page under /demo/defects/<id> that reproduces the defect
 *     ONLY on the form factors it actually affects (via viewport/touch
 *     emulation — the page itself is form-factor unaware);
 *   - declares `affects(env)` — a predicate over an environment/profile
 *     record (category/device predicate) saying where the defect is EXPECTED;
 *   - declares `verify(page)` — how the engine checks whether the defect
 *     actually reproduced in the rendered page.
 *
 * The matrix engine runs fixture verification per profile and records
 * reproduced = TRUE | FALSE | NOT_VERIFIED with evidence — never fabricated:
 * NOT_VERIFIED is recorded whenever the page could not be evaluated.
 */

const FIXTURES = [
	{
		id: 'device-interactions',
		title: 'Device interaction exercise page (tap, long-press, swipe, drag, type, upload)',
		description: 'A representative page exercising every gesture vocabulary item: tap target, double-tap, long-press menu, swipe carousel, drag-sort list, keyboard typing, wheel scroll, file upload, download link and refresh/back navigation hooks. Used to prove gesture execution from an actual environment — each interaction is observable in DOM state.',
		/** Runs on every form factor — gestures differ by context (touch vs mouse). */
		affects: () => true,
		expectedSummary: 'interaction page loads on all profiles; gesture evidence is context-dependent and always recorded',
		/** DOM probe: the page's gesture ledger (populated ONLY by real events). */
		verify: `
			() => {
				const ledger = document.querySelector('#fixture-gesture-ledger');
				if (!ledger) return { evaluated: false };
				return { evaluated: true, reproduced: ledger.dataset.events !== '', evidence: { events: ledger.dataset.events || null } };
			}`
	},
	{
		id: 'login-button-overlaps-keyboard',
		title: 'Login button overlaps keyboard on touch devices',
		description: 'On narrow touch devices the sign-in button is covered by the simulated keyboard tray; desktop viewports are unaffected.',
		/** Expected on phones and tablets (touch, narrow viewport) — not desktop. */
		affects: (env) => env?.deviceType === 'mobile' || env?.deviceType === 'tablet',
		expectedSummary: 'reproduces on touch devices (phone/tablet), not on desktop',
		/** DOM probe executed in the rendered page. */
		verify: `
			() => {
				const button = document.querySelector('#fixture-login-button');
				const tray = document.querySelector('#fixture-keyboard-tray');
				if (!button || !tray) return { evaluated: false };
				const b = button.getBoundingClientRect();
				const t = tray.getBoundingClientRect();
				const overlaps = !(b.bottom <= t.top || t.bottom <= b.top || b.right <= t.left || t.right <= b.left);
				return { evaluated: true, reproduced: overlaps, evidence: { buttonBottom: b.bottom, trayTop: t.top } };
			}`
	},
	{
		id: 'wide-table-overflow',
		title: 'Wide data table overflows viewport on phones',
		description: 'A 6-column table with min-width cells overflows horizontally on phone widths; tablets and desktops fit.',
		/** Expected on phones only (narrow viewport); tablets/desktop fit. */
		affects: (env) => env?.deviceType === 'mobile',
		expectedSummary: 'reproduces on phones, not on tablets or desktop',
		verify: `
			() => {
				const table = document.querySelector('#fixture-wide-table');
				if (!table) return { evaluated: false };
				const overflow = table.scrollWidth > document.documentElement.clientWidth + 1;
				return { evaluated: true, reproduced: overflow, evidence: { scrollWidth: table.scrollWidth, clientWidth: document.documentElement.clientWidth } };
			}`
	},
	{
		id: 'meeting-media-permission-recovery',
		title: 'Meeting join does not recover after camera permission denial and re-grant',
		description: 'Known defect: when camera permission is first denied and later re-granted, the meeting join button stays disabled (recovery missing). Reproduces via the denial→grant flow on the meeting fixture page; a correct implementation would re-enable join after the grant.',
		/** Expected where meeting/camera flows run — every form factor (defect is JS-level, not form-factor specific). */
		affects: () => true,
		expectedSummary: 'reproduces via the deny→grant flow: join stays disabled after re-grant (defect) or re-enables (fixed)',
		/** DOM probe: reads the fixture's permission-flow ledger. */
		verify: `
			() => {
				const ledger = document.querySelector('#fixture-media-ledger');
				const join = document.querySelector('#fixture-join-btn');
				if (!ledger || !join) return { evaluated: false };
				return {
					evaluated: true,
					reproduced: ledger.dataset.state === 'denied-then-granted' && join.disabled,
					evidence: { flow: ledger.dataset.state, joinDisabled: join.disabled }
				};
			}`
	}
];

const byId = new Map(FIXTURES.map((fixture) => [fixture.id, fixture]));

/**
 * Mount the demo pages that reproduce the fixtures. Each page renders the
 * same markup; CSS media/touch queries decide whether the defect shows, so
 * the reproduction is a property of the FORM FACTOR, not a faked result.
 */
export function mountDefectFixtures(router) {
	router.get('/demo/defects', (_request, response) => {
		response.setHeader('Content-Type', 'text/html; charset=utf-8');
		response.end(`<!doctype html><html><head><title>Qase known-defect fixtures</title>
			<style>body{font-family:system-ui;margin:2rem;line-height:1.5}ul{padding-left:1.2rem}</style>
			</head><body><h1>Known-defect fixtures</h1><ul>
			${FIXTURES.map((f) => `<li><a href="/demo/defects/${f.id}">${f.id}</a> — ${f.title}</li>`).join('')}
			</ul></body></html>`);
	});

	for (const fixture of FIXTURES) {
		router.get(`/demo/defects/${fixture.id}`, (_request, response) => {
			response.setHeader('Content-Type', 'text/html; charset=utf-8');
			response.end(fixturePage(fixture));
		});
	}
	// Unknown fixture ids: honest 404 with explicit text (not the generic
	// demo catch-all) so the gap is obvious when a fixture id is stale.
	router.get('/demo/defects/:unknownId', (_request, response) => {
		response.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
		response.end('<!doctype html><html><body>Unknown fixture page.</body></html>');
	});
}

/** RT4 (#14756): render a fixture page by id without a router (for tests). */
export function renderDefectFixturePage(id) {
	const fixture = byId.get(id);
	return fixture ? fixturePage(fixture) : null;
}

function fixturePage(fixture) {
	if (fixture.id === 'device-interactions') {
		return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
			<title>${fixture.title}</title><style>
			body { font-family: system-ui; margin: 1rem; }
			button { min-height: 44px; min-width: 44px; margin: 4px; }
			#fixture-gesture-ledger { margin-top: 1rem; padding: .5rem; background: #f4f4f4; white-space: pre-wrap; min-height: 2rem; }
			#fixture-swipe-track { display: flex; overflow-x: auto; width: 80%; height: 120px; border: 1px solid #888; }
			#fixture-swipe-track > div { min-width: 200px; height: 100px; background: #9cf; display: grid; place-items: center; }
			#fixture-drag-list li { padding: .5rem; border: 1px solid #aaa; margin: .25rem 0; background: #fff; }
			#fixture-scroll-area { height: 400px; overflow-y: scroll; border: 1px solid #888; }
			#fixture-scroll-content { height: 4000px; background: linear-gradient(#fff, #99f); }
			#fixture-longpress-menu { display: none; margin-top: .5rem; padding: .5rem; border: 1px solid #6a6; background: #efe; }
			#fixture-longpress-menu.open { display: block; }
			</style></head><body>
			<h1>Device interactions</h1>
			<button id="fixture-tap-btn">Tap me</button>
			<button id="fixture-doubletap-btn">Double-tap me</button>
			<button id="fixture-longpress-btn">Hold me…</button>
			<button id="fixture-download-btn" download="fixture-download.txt" href="data:text/plain,downloaded-ok">Download</button>
			<div id="fixture-longpress-menu" role="menu"><button id="fixture-menu-copy">Copy</button></div>
			<input id="fixture-type-input" placeholder="Type here" autocomplete="off">
			<input id="fixture-file-input" type="file">
			<div id="fixture-swipe-track" tabindex="0"><div>Card 1</div><div>Card 2</div><div>Card 3</div><div>Card 4</div><div>Card 5</div></div>
			<ul id="fixture-drag-list" draggable="false"><li id="fixture-drag-a" draggable="true">Item A</li><li id="fixture-drag-b" draggable="true">Item B</li><li id="fixture-drag-c" draggable="true">Item C</li></ul>
			<div id="fixture-scroll-area"><div id="fixture-scroll-content">Scroll me (4000px)</div></div>
			<a id="fixture-next-page" href="/demo/defects/login-button-overlaps-keyboard">Second page (back-navigation test)</a>
			<div id="fixture-gesture-ledger" aria-live="polite"></div>
			<script>
			(function () {
				var ledger = document.getElementById('fixture-gesture-ledger');
				function log(kind, detail) {
					ledger.dataset.events = (ledger.dataset.events ? ledger.dataset.events + ',' : '') + kind + (detail ? ':' + detail : '');
					ledger.textContent = ledger.dataset.events;
				}
				var tapBtn = document.getElementById('fixture-tap-btn');
				var dtapBtn = document.getElementById('fixture-doubletap-btn');
				var lpBtn = document.getElementById('fixture-longpress-btn');
				var menu = document.getElementById('fixture-longpress-menu');
				var track = document.getElementById('fixture-swipe-track');
				var fileInput = document.getElementById('fixture-file-input');
				document.getElementById('fixture-tap-btn').addEventListener('click', function () { log('tap'); });
				var lastTap = 0;
				dtapBtn.addEventListener('click', function () {
					var now = Date.now();
					if (now - lastTap < 450) { log('double_tap'); lastTap = 0; } else { lastTap = now; }
				});
				var holdTimer = null;
				lpBtn.addEventListener('pointerdown', function () {
					holdTimer = setTimeout(function () { menu.classList.add('open'); log('long_press', 'menu-open'); }, 500);
				});
				function cancelHold() { clearTimeout(holdTimer); }
				lpBtn.addEventListener('pointerup', cancelHold);
				lpBtn.addEventListener('pointerleave', cancelHold);
				document.getElementById('fixture-menu-copy').addEventListener('click', function () { log('menu_copy'); });
				var typing = '';
				document.getElementById('fixture-type-input').addEventListener('input', function (e) {
					typing += e.data || '';
					log('type', typing);
				});
				document.getElementById('fixture-type-input').addEventListener('keydown', function (e) { log('key', e.key); });
				fileInput.addEventListener('change', function () { log('upload', String(fileInput.files.length)); });
				document.getElementById('fixture-download-btn').addEventListener('click', function () { log('download_click'); });
				var swipeStartX = null;
				track.addEventListener('pointerdown', function (e) { swipeStartX = e.clientX; });
				track.addEventListener('pointerup', function (e) {
					if (swipeStartX === null) return;
					var dx = e.clientX - swipeStartX;
					if (Math.abs(dx) > 40) log('swipe', (dx < 0 ? 'left' : 'right') + ':' + Math.round(dx));
					swipeStartX = null;
				});
				track.addEventListener('scroll', function () {
					clearTimeout(track._t);
					track._t = setTimeout(function () { log('swipe_scroll', String(Math.round(track.scrollLeft))); }, 120);
				});
				document.getElementById('fixture-scroll-area').addEventListener('scroll', function () {
					clearTimeout(this._t);
					var area = this;
					this._t = setTimeout(function () { log('scroll', String(Math.round(area.scrollTop))); }, 120);
				});
				var dragged = null;
				[].forEach.call(document.querySelectorAll('#fixture-drag-list li'), function (li) {
					li.addEventListener('dragstart', function () { dragged = li; });
				});
				document.getElementById('fixture-drag-list').addEventListener('dragover', function (e) { e.preventDefault(); });
				document.getElementById('fixture-drag-list').addEventListener('drop', function (e) {
					e.preventDefault();
					if (!dragged) return;
					var target = e.target.closest('li');
					if (!target || target === dragged) return;
					var list = document.getElementById('fixture-drag-list');
					var items = [].slice.call(list.children);
					var from = items.indexOf(dragged), to = items.indexOf(target);
					list.removeChild(dragged);
					list.insertBefore(dragged, to > from ? target.nextSibling : target);
					log('drag', 'moved:' + dragged.id);
					dragged = null;
				});
				window.addEventListener('orientationchange', function () { log('orientation', window.innerWidth > window.innerHeight ? 'landscape' : 'portrait'); });
				window.addEventListener('resize', function () {
					var o = window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
					if (window._lastOrientation !== o) { window._lastOrientation = o; log('orientation', o); }
				});
			})();
			</script>
			</body></html>`;
	}
	if (fixture.id === 'login-button-overlaps-keyboard') {
		return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
			<title>${fixture.title}</title><style>
			/* The keyboard tray only renders on coarse pointers (touch) below 1100px —
			   phone AND tablet form factors. Desktop (no touch, wide) never shows it.
			   The form fills the viewport with the button pinned at the bottom edge,
			   so on touch form factors the fixed tray covers it. */
			body { margin: 0; }
			#fixture-keyboard-tray { display: none; }
			@media (pointer: coarse) and (max-width: 1100px) {
				#fixture-keyboard-tray { display: block; position: fixed; bottom: 0; left: 0; right: 0; height: 180px; background: #ddd; z-index: 10; }
			}
			#fixture-login-form { padding: 2rem; min-height: 100vh; display: flex; flex-direction: column; justify-content: flex-end; }
			#fixture-login-form h1, #fixture-login-form label { display: block; }
			#fixture-login-button { width: 220px; height: 48px; margin-bottom: 40px; }
			</style></head><body>
			<form id="fixture-login-form">
				<h1>Sign in</h1>
				<input type="email" placeholder="Email" autocomplete="off">
				<input type="password" placeholder="Password" autocomplete="off">
				<button id="fixture-login-button" type="button">Sign in</button>
			</form>
			<div id="fixture-keyboard-tray" aria-hidden="true"></div>
			</body></html>`;
	}
	if (fixture.id === 'wide-table-overflow') {
		return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
			<title>${fixture.title}</title><style>
			/* Cells have a fixed min-width; only tablet/desktop viewports (≥1024)
			   fit all columns — phone widths overflow. */
			#fixture-wide-table td, #fixture-wide-table th { min-width: 150px; padding: 8px; border: 1px solid #ccc; }
			</style></head><body>
			<table id="fixture-wide-table"><thead><tr>
			<th>Col 1</th><th>Col 2</th><th>Col 3</th><th>Col 4</th><th>Col 5</th><th>Col 6</th>
			</tr></thead><tbody><tr><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td><td>6</td></tr></tbody></table>
			</body></html>`;
	}
	if (fixture.id === 'meeting-media-permission-recovery') {
		return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
			<title>${fixture.title}</title><style>
			body { font-family: system-ui; margin: 1rem; }
			button { min-height: 44px; min-width: 44px; margin: 4px; }
			video { width: 240px; background: #000; }
			#fixture-media-ledger { margin-top: 1rem; padding: .5rem; background: #f4f4f4; }
			#fixture-denied-banner { display: none; color: #a00; margin: .5rem 0; }
			#fixture-denied-banner.show { display: block; }
			</style></head><body>
			<h1>Meeting join</h1>
			<button id="fixture-request-camera">Enable camera</button>
			<button id="fixture-join-btn" disabled>Join meeting</button>
			<button id="fixture-mute-btn" disabled>Mute</button>
			<button id="fixture-camera-off-btn" disabled>Camera off</button>
			<p id="fixture-denied-banner">Camera permission denied — join unavailable.</p>
			<video id="fixture-preview" autoplay muted playsinline></video>
			<div id="fixture-media-ledger" data-state="idle">idle</div>
			<script>
			(function () {
				// KNOWN DEFECT: the denial path permanently disables join. A
				// correct recovery would re-enable join when a later request
				// succeeds — this fixture deliberately omits it so the defect
				// reproduces under the deny→grant flow.
				var ledger = document.getElementById('fixture-media-ledger');
				var join = document.getElementById('fixture-join-btn');
				var banner = document.getElementById('fixture-denied-banner');
				var mute = document.getElementById('fixture-mute-btn');
				var cameraOff = document.getElementById('fixture-camera-off-btn');
				var preview = document.getElementById('fixture-preview');
				var stream = null;
				var hadDenied = false;
				function setState(state) { ledger.dataset.state = state; ledger.textContent = state; }
				document.getElementById('fixture-request-camera').onclick = async function () {
					try {
					var capture = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
					stream = capture;
					preview.srcObject = capture;
					globalThis.__qaseMediaEvidence = globalThis.__qaseMediaEvidence || {};
					globalThis.__qaseMediaEvidence.callStream = capture;
						setState(hadDenied ? 'denied-then-granted' : 'granted');
						banner.classList.remove('show');
						// KNOWN DEFECT: the denial once happened → join stays
						// disabled forever. Correct recovery would re-enable it.
						if (!hadDenied) { join.disabled = false; mute.disabled = false; cameraOff.disabled = false; }
					} catch (error) {
						hadDenied = true;
						setState('denied:' + error.name);
						join.disabled = true;
						mute.disabled = true;
						cameraOff.disabled = true;
						banner.classList.add('show');
					}
				};
				mute.onclick = function () { stream.getAudioTracks().forEach(function (t) { t.enabled = !t.enabled; }); };
				cameraOff.onclick = function () { stream.getVideoTracks().forEach(function (t) { t.enabled = !t.enabled; }); };
				// RT4 (#14756): the page's own meeting controls, exposed to the
				// harness via __qaseMeetingControls so meeting_controls /
				// meeting_recovery drive THIS page's real flows. The defect is
				// preserved: after a denial, join never re-enables.
				globalThis.__qaseMeetingControls = {
					join: function () { if (!join.disabled) { join.click(); } },
					requestMedia: function () { document.getElementById('fixture-request-camera').click(); },
					mute: function () { mute.click(); },
					unmute: function () { mute.click(); },
					cameraOff: function () { cameraOff.click(); },
					cameraOn: function () { cameraOff.click(); },
					leave: function () { stream && stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
				};
				join.onclick = function () { /* joined — nothing else to do on this page */ };
			})();
			</script>
			</body></html>`;
	}
	return '<!doctype html><html><body>Unknown fixture page.</body></html>';
}

export function listDefectFixtures() {
	return FIXTURES.map(({ id, title, description, expectedSummary }) => ({ id, title, description, expectedSummary }));
}

export function getDefectFixture(id) {
	return byId.get(id) ?? null;
}

/**
 * Expected reproduction verdict for an environment record — pure predicate,
 * no execution. The ENGINE decides reproduced=TRUE/FALSE by probing the page
 * under that profile's emulation; this only states the expectation so a
 * mismatch is visible (e.g. defect "expected" on desktop but not reproducing).
 */
export function fixtureExpectation(fixture, env) {
	if (!fixture || !env || typeof fixture.affects !== 'function') return 'NOT_VERIFIED';
	return fixture.affects(env) ? 'EXPECTED' : 'NOT_EXPECTED';
}
