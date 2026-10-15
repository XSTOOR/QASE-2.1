/** Native capture is retained: Chromium supplies synthetic devices at launch. */
export const SYNTHETIC_MEDIA_ARGS = Object.freeze([
	'--use-fake-device-for-media-stream',
	'--autoplay-policy=no-user-gesture-required'
]);

export function installMediaObserver() {
	if (globalThis.__qaseMediaEvidence || !navigator.mediaDevices?.getUserMedia) return;
	const requests = [];
	const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
	const trackState = track => ({ kind: track.kind, enabled: track.enabled, muted: track.muted, readyState: track.readyState });
	Object.defineProperty(globalThis, '__qaseMediaEvidence', {
		value: {
			probe: false,
			read: () => requests.map(({ tracks, ...request }) => ({ ...request, tracks: tracks.map(trackState) }))
		}
	});
	navigator.mediaDevices.getUserMedia = async function (constraints) {
		const request = {
			source: globalThis.__qaseMediaEvidence.probe ? 'probe' : 'application',
			audio: Boolean(constraints?.audio), video: Boolean(constraints?.video),
			outcome: 'pending', ts: Date.now(), tracks: []
		};
		requests.push(request);
		if (requests.length > 50) requests.shift();
		try {
			const stream = await nativeCapture(constraints);
			request.outcome = 'granted';
			request.tracks = stream.getTracks();
			return stream;
		} catch (error) {
			request.outcome = 'rejected';
			request.error = error.name;
			throw error;
		}
	};
}

export async function inspectMedia(page) {
	return page.evaluate(async () => {
		const permissionState = async name => {
			try { return (await navigator.permissions.query({ name })).state; } catch { return 'unsupported'; }
		};
		const displayCaptureSupported = Boolean(navigator.mediaDevices?.getDisplayMedia);
		return {
			secureContext: isSecureContext,
			captureSupported: Boolean(navigator.mediaDevices?.getUserMedia),
			displayCaptureSupported,
			permission: await permissionState('microphone'),
			cameraPermission: await permissionState('camera'),
			requests: globalThis.__qaseMediaEvidence?.read() ?? []
		};
	});
}

// RT4 (#14756): synthetic media is a CHROMIUM-only capability (launch-time
// fake device flags). Every other engine gets an honest UNAVAILABLE with a
// reason — never a simulated pass and never a silent skip.
export const SYNTHETIC_MEDIA_UNAVAILABLE_REASON = Object.freeze({
	webkit: 'Synthetic camera/microphone devices are a Chromium-only capability; WebKit exposes no fake-device launch flag, so camera/microphone testing is UNAVAILABLE in this runtime (recorded as a gap, never as a pass).',
	firefox: 'Synthetic camera/microphone devices are a Chromium-only capability; Firefox headless cannot be driven through its permission prompt automatically, so camera/microphone testing is UNAVAILABLE in this runtime (recorded as a gap, never as a pass).'
});

/** Honest synthetic-media capability for an engine id (default chromium). */
export function syntheticMediaCapability(engineId) {
	if (engineId === 'chromium') {
		return { available: true, reason: null };
	}
	return {
		available: false,
		reason: SYNTHETIC_MEDIA_UNAVAILABLE_REASON[engineId]
			?? `Synthetic camera/microphone devices are a Chromium-only capability; engine "${engineId}" cannot launch them, so camera/microphone testing is UNAVAILABLE in this runtime (recorded as a gap, never as a pass).`
	};
}

const permissionControllers = new WeakMap();

// RT4 (#14756): CDP permission names for every media permission the tools
// set. Microphone kept for back-compat; camera + screen capture added.
const CDP_PERMISSION_NAMES = Object.freeze({
	microphone: { name: 'microphone' },
	camera: { name: 'camera' },
	screen_capture: { name: 'video_capture' },
	display_capture: { name: 'display-capture' }
});

export async function setMediaPermission(context, page, permission, target = 'microphone') {
	const descriptor = CDP_PERMISSION_NAMES[target];
	if (!descriptor) throw new Error(`Unknown media permission target "${target}".`);
	// Chrome removes overrides when their CDP session detaches. Keep a browser
	// session alive for this context, including when the selected tab is closed.
	let controller = permissionControllers.get(context);
	if (!controller) {
		controller = (async () => {
			const target0 = await context.newCDPSession(page);
			let browserContextId;
			try { ({ targetInfo: { browserContextId } } = await target0.send('Target.getTargetInfo')); }
			finally { await target0.detach(); }
			if (!browserContextId) throw new Error('Media permission requires an isolated browser context.');
			const client = await context.browser().newBrowserCDPSession();
			context.once('close', () => { permissionControllers.delete(context); void client.detach().catch(() => {}); });
			return { client, browserContextId };
		})();
		permissionControllers.set(context, controller);
		controller.catch(() => permissionControllers.delete(context));
	}
	const { client, browserContextId } = await controller;
	await client.send('Browser.setPermission', {
		permission: descriptor,
		setting: permission,
		origin: new URL(page.url()).origin, browserContextId
	});
}

export async function setMicrophonePermission(context, page, permission) {
	return setMediaPermission(context, page, permission, 'microphone');
}

export async function probeMicrophone(page, durationMs = 1200) {
	const duration = Math.min(3000, Math.max(100, Number(durationMs) || 1200));
	return page.evaluate(async duration => {
		const result = { outcome: 'unavailable', audioTracks: 0, rms: 0, signalDetected: false, tracksStopped: true };
		if (!navigator.mediaDevices?.getUserMedia) return { ...result, error: 'MediaDevicesUnavailable' };
		let stream;
		let audioContext;
		let timeout;
		let cancelled = false;
		try {
			if (globalThis.__qaseMediaEvidence) globalThis.__qaseMediaEvidence.probe = true;
			// Probe the device signal directly: voice processing can suppress the
			// synthetic test tone. Application capture keeps its own constraints.
			const capture = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
			capture.then(late => { if (cancelled) late.getTracks().forEach(track => track.stop()); }, () => {});
			stream = await Promise.race([
				capture,
				new Promise((_, reject) => { timeout = setTimeout(() => reject(new DOMException('Capture timed out', 'TimeoutError')), 5000); })
			]);
			clearTimeout(timeout);
			result.audioTracks = stream.getAudioTracks().length;
			result.tracks = stream.getAudioTracks().map(track => ({ kind: track.kind, enabled: track.enabled, muted: track.muted, readyState: track.readyState }));
			audioContext = new AudioContext();
			const source = audioContext.createMediaStreamSource(stream);
			const analyser = audioContext.createAnalyser();
			analyser.fftSize = 2048;
			source.connect(analyser);
			await audioContext.resume();
			const samples = new Float32Array(analyser.fftSize);
			const deadline = performance.now() + duration;
			while (performance.now() < deadline) {
				analyser.getFloatTimeDomainData(samples);
				let sum = 0;
				for (const value of samples) sum += value * value;
				result.rms = Math.max(result.rms, Math.sqrt(sum / samples.length));
				await new Promise(resolve => setTimeout(resolve, 40));
			}
			result.rms = Number(result.rms.toFixed(6));
			result.signalDetected = result.rms > 0.0001;
			result.outcome = 'captured';
		} catch (error) {
			result.outcome = 'rejected';
			result.error = error.name;
		} finally {
			cancelled = true;
			clearTimeout(timeout);
			stream?.getTracks().forEach(track => track.stop());
			result.tracksStopped = !stream || stream.getTracks().every(track => track.readyState === 'ended');
			await audioContext?.close().catch(() => {});
			if (globalThis.__qaseMediaEvidence) globalThis.__qaseMediaEvidence.probe = false;
		}
		return result;
	}, duration);
}

// ---------------------------------------------------------------------------
// RT4 (#14756) · Camera probe — real capture on Chromium's synthetic device.
// Opens getUserMedia({video}), reads back the track state and ONE decoded
// frame (frame length must be > 0 — a real, if synthetic, signal). Track is
// released afterwards; nothing is claimed about physical hardware.
// ---------------------------------------------------------------------------
export async function probeCamera(page, { durationMs = 800 } = {}) {
	const duration = Math.min(3000, Math.max(100, Number(durationMs) || 800));
	return page.evaluate(async duration => {
		const result = {
			outcome: 'unavailable',
			videoTracks: 0,
			frameNonEmpty: false,
			frameDimensions: null,
			tracksStopped: true,
			signalDetected: false
		};
		if (!navigator.mediaDevices?.getUserMedia) return { ...result, error: 'MediaDevicesUnavailable' };
		let stream;
		let timeout;
		let cancelled = false;
		try {
			if (globalThis.__qaseMediaEvidence) globalThis.__qaseMediaEvidence.probe = true;
			const capture = navigator.mediaDevices.getUserMedia({
				video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false
			});
			capture.then(late => { if (cancelled) late.getTracks().forEach(track => track.stop()); }, () => {});
			stream = await Promise.race([
				capture,
				new Promise((_, reject) => { timeout = setTimeout(() => reject(new DOMException('Capture timed out', 'TimeoutError')), 5000); })
			]);
			clearTimeout(timeout);
			result.videoTracks = stream.getVideoTracks().length;
			result.tracks = stream.getVideoTracks().map(track => ({ kind: track.kind, enabled: track.enabled, muted: track.muted, readyState: track.readyState }));
			if (!result.videoTracks) throw new DOMException('No video track returned', 'NotFoundError');
			// Read a REAL frame from the synthetic device: draw one video frame
			// to a canvas and count non-zero pixels. An all-black canvas is
			// rejected — the synthetic device renders an animated scene.
			const video = document.createElement('video');
			video.srcObject = new MediaStream(stream.getVideoTracks());
			video.muted = true;
			await video.play();
			await new Promise(resolve => {
				if (video.readyState >= 2 && video.videoWidth > 0) return resolve();
				video.onloadeddata = resolve;
				setTimeout(resolve, duration + 1000);
			});
			result.frameDimensions = { width: video.videoWidth, height: video.videoHeight };
			const canvas = document.createElement('canvas');
			canvas.width = video.videoWidth || 320;
			canvas.height = video.videoHeight || 240;
			const context2d = canvas.getContext('2d', { willReadFrequently: true });
			let nonZero = 0;
			let brightest = 0;
			// Sample several frames over the probe window — the synthetic
			// scene animates, so any sampled frame with content proves signal.
			const deadline = performance.now() + duration;
			do {
				context2d.drawImage(video, 0, 0, canvas.width, canvas.height);
				const data = context2d.getImageData(0, 0, canvas.width, canvas.height).data;
				nonZero = 0;
				brightest = 0;
				for (let index = 0; index < data.length; index += 4) {
					const luminance = (data[index] + data[index + 1] + data[index + 2]) / 3;
					if (luminance > 0) nonZero += 1;
					if (luminance > brightest) brightest = luminance;
				}
				if (nonZero > 0) break;
				await new Promise(resolve => setTimeout(resolve, 120));
			} while (performance.now() < deadline);
			result.frameNonEmpty = nonZero > 0;
			result.signalDetected = nonZero > 0 && brightest > 8;
			result.sampledNonZeroPixels = nonZero;
			result.sampledBrightestLuminance = Math.round(brightest);
			result.outcome = 'captured';
		} catch (error) {
			result.outcome = 'rejected';
			result.error = error.name;
		} finally {
			cancelled = true;
			clearTimeout(timeout);
			stream?.getTracks().forEach(track => track.stop());
			result.tracksStopped = !stream || stream.getTracks().every(track => track.readyState === 'ended');
			if (globalThis.__qaseMediaEvidence) globalThis.__qaseMediaEvidence.probe = false;
		}
		return result;
	}, duration);
}

// ---------------------------------------------------------------------------
// RT4 (#14756) · Screen-share probe — getDisplayMedia against the local
// virtual desktop (Chromium auto-selects a capture source when launched with
// --auto-select-desktop-capture-source; browserBridge adds the arg). Track
// state + one sampled frame prove real pipeline; labeled VIRTUAL — never a
// real monitor capture claim.
// ---------------------------------------------------------------------------
export async function probeScreenShare(page, { durationMs = 800 } = {}) {
	const duration = Math.min(3000, Math.max(100, Number(durationMs) || 800));
	return page.evaluate(async duration => {
		const result = {
			outcome: 'unavailable',
			videoTracks: 0,
			frameNonEmpty: false,
			frameDimensions: null,
			tracksStopped: true,
			sourceLabel: null,
			signalDetected: false
		};
		if (!navigator.mediaDevices?.getDisplayMedia) return { ...result, error: 'DisplayCaptureUnsupported' };
		let stream;
		let timeout;
		let cancelled = false;
		try {
			if (globalThis.__qaseMediaEvidence) globalThis.__qaseMediaEvidence.probe = true;
			const capture = navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
			capture.then(late => { if (cancelled) late.getTracks().forEach(track => track.stop()); }, () => {});
			stream = await Promise.race([
				capture,
				new Promise((_, reject) => { timeout = setTimeout(() => reject(new DOMException('Capture timed out', 'TimeoutError')), 5000); })
			]);
			clearTimeout(timeout);
			const [track] = stream.getVideoTracks();
			result.videoTracks = stream.getVideoTracks().length;
			result.sourceLabel = track?.label || null;
			result.tracks = stream.getVideoTracks().map(t => ({ kind: t.kind, enabled: t.enabled, muted: t.muted, readyState: t.readyState }));
			if (!result.videoTracks) throw new DOMException('No display video track returned', 'NotFoundError');
			// Sample a real frame from the virtual desktop stream.
			const video = document.createElement('video');
			video.srcObject = new MediaStream(stream.getVideoTracks());
			video.muted = true;
			await video.play();
			await new Promise(resolve => {
				if (video.readyState >= 2 && video.videoWidth > 0) return resolve();
				video.onloadeddata = resolve;
				setTimeout(resolve, duration + 1000);
			});
			result.frameDimensions = { width: video.videoWidth, height: video.videoHeight };
			const canvas = document.createElement('canvas');
			canvas.width = video.videoWidth || 320;
			canvas.height = video.videoHeight || 240;
			const context2d = canvas.getContext('2d', { willReadFrequently: true });
			let nonZero = 0;
			const deadline = performance.now() + duration;
			do {
				context2d.drawImage(video, 0, 0, canvas.width, canvas.height);
				const data = context2d.getImageData(0, 0, canvas.width, canvas.height).data;
				nonZero = 0;
				for (let index = 0; index < data.length; index += 4) {
					if (data[index] + data[index + 1] + data[index + 2] > 0) nonZero += 1;
				}
				if (nonZero > 0) break;
				await new Promise(resolve => setTimeout(resolve, 120));
			} while (performance.now() < deadline);
			result.frameNonEmpty = nonZero > 0;
			result.signalDetected = nonZero > 0;
			result.sampledNonZeroPixels = nonZero;
			result.outcome = 'captured';
		} catch (error) {
			result.outcome = 'rejected';
			result.error = error.name;
		} finally {
			cancelled = true;
			clearTimeout(timeout);
			stream?.getTracks().forEach(track => track.stop());
			result.tracksStopped = !stream || stream.getTracks().every(track => track.readyState === 'ended');
			if (globalThis.__qaseMediaEvidence) globalThis.__qaseMediaEvidence.probe = false;
		}
		return result;
	}, duration);
}

// ---------------------------------------------------------------------------
// RT4 (#14756) · Honest verdict mapping — a probe result becomes exactly one
// execution state. Granted = real capture verified. Denied = the DENIAL path
// executed correctly (permission correctly blocked) — distinct from
// Unavailable (engine cannot test) and Execution Failed (probe crashed).
// ---------------------------------------------------------------------------
export function mediaProbeVerdict(probe, capability) {
	if (!capability?.available) {
		return { status: 'UNAVAILABLE', reason: capability?.reason ?? 'Synthetic media capability unavailable in this runtime.' };
	}
	if (!probe) return { status: 'EXECUTION_FAILED', reason: 'No probe result recorded.' };
	if (probe.outcome === 'captured') {
		if (probe.signalDetected === false) {
			return { status: 'EXECUTION_FAILED', reason: 'Capture opened but no signal was detected in the sampled frames.' };
		}
		return { status: 'GRANTED', reason: null };
	}
	if (probe.outcome === 'rejected') {
		if (probe.error === 'NotAllowedError') return { status: 'DENIED', reason: 'Permission was denied — capture rejected with NotAllowedError (expected denial path).' };
		if (probe.error === 'NotFoundError') return { status: 'EXECUTION_FAILED', reason: 'Capture rejected with NotFoundError — no media device presented.' };
		return { status: 'EXECUTION_FAILED', reason: `Capture rejected: ${probe.error ?? 'unknown error'}.` };
	}
	return { status: 'EXECUTION_FAILED', reason: probe.error ? `Probe did not capture (${probe.error}).` : 'Probe did not capture.' };
}

/** Call-control verification: reads the live app-owned stream's track states. */
export async function inspectCallControls(page) {
	return page.evaluate(async () => {
		const stream = globalThis.__qaseMediaEvidence?.callStream ?? window.stream ?? null;
		if (!stream) return { active: false, tracks: [], note: 'No application media stream held by the page.' };
		return {
			active: stream.active,
			tracks: stream.getTracks().map(track => ({
				kind: track.kind,
				enabled: track.enabled,
				muted: track.muted,
				readyState: track.readyState,
				label: track.label || null
			}))
		};
	});
}

// ---------------------------------------------------------------------------
// RT4 (#14756) · Meeting-controls workflow — drive the PAGE's own join/mute/
// camera/leave controls and record per-control evidence from real track
// state. Controls are discovered semantically (a page may register
// __qaseMeetingControls handlers; otherwise visible buttons matching control
// keywords are used). Every step reports observed state — nothing is assumed.
// ---------------------------------------------------------------------------
const MEETING_CONTROL_KEYWORDS = {
	mute: ['mute', 'mute mic', 'mute microphone'],
	unmute: ['unmute', 'unmute mic', 'unmute microphone'],
	cameraOff: ['camera off', 'turn off camera', 'video off', 'stop video'],
	cameraOn: ['camera on', 'turn on camera', 'video on', 'start video'],
	leave: ['leave', 'leave meeting', 'end call', 'hang up', 'end']
};

/** Snapshot the app-owned stream's observable call state. */
async function meetingCallState(page) {
	return page.evaluate(() => {
		const stream = globalThis.__qaseMediaEvidence?.callStream ?? window.stream ?? null;
		if (!stream) return { joined: false, active: false, audioEnabled: null, videoEnabled: null, tracks: [] };
		const audio = stream.getAudioTracks()[0] ?? null;
		const video = stream.getVideoTracks()[0] ?? null;
		return {
			// joined = an ACTIVE call (live tracks), not just a stream reference.
			joined: stream.active === true && stream.getTracks().some(track => track.readyState === 'live'),
			active: stream.active,
			audioEnabled: audio ? audio.enabled : null,
			videoEnabled: video ? video.enabled : null,
			tracks: stream.getTracks().map(track => ({ kind: track.kind, enabled: track.enabled, readyState: track.readyState }))
		};
	});
}

/** Resolve a control to a clickable element: page hook first, then DOM scan. */
async function resolveMeetingControl(page, control) {
	return page.evaluate((controlName) => {
		const hook = globalThis.__qaseMeetingControls?.[controlName];
		if (hook) return { via: 'pageHook', selector: null, label: null };
		const wanted = MEETING_CONTROL_KEYWORDS[controlName];
		const buttons = Array.from(document.querySelectorAll('button, [role="button"], a[onclick]'))
			.filter(element => element.getClientRects().length && !element.disabled)
			.map(element => ({ element, text: (element.innerText || element.getAttribute('aria-label') || element.textContent || '').trim().toLowerCase() }))
			.filter(({ text }) => wanted.some(keyword => text === keyword || text.includes(keyword)));
		if (!buttons.length) return null;
		// Deterministic choice: shortest matching text wins (avoids "Leave settings" matching "leave").
		buttons.sort((a, b) => a.text.length - b.text.length);
		buttons[0].element.setAttribute('data-qase-meeting-control', controlName);
		return { via: 'dom', selector: `[data-qase-meeting-control="${controlName}"]`, label: buttons[0].text.slice(0, 60) };
	}, control).catch(() => null);
}

/**
 * Drive the meeting workflow: join (caller supplies the page's own join
 * mechanism via a selector — or the __qaseMeetingControls.join hook), then
 * mute/unmute, camera off/on, and leave. Each control reports the observable
 * stream state before and after. A control that cannot be resolved is
 * recorded UNRESOLVED — never a fake success.
 */
export async function exerciseMeetingControls(page, { joinSelector, controls } = {}) {
	const order = Array.isArray(controls) && controls.length ? controls : ['mute', 'unmute', 'cameraOff', 'cameraOn', 'leave'];
	const steps = [];

	const clickControl = async (name, selector, expect) => {
		const before = await meetingCallState(page);
		try {
			if (selector) await page.click(selector);
			else await page.evaluate((controlName) => globalThis.__qaseMeetingControls?.[controlName]?.(), name);
			await page.waitForTimeout(250);
		} catch (error) {
			steps.push({ control: name, status: 'ERROR', error: error.message, before, after: before });
			return false;
		}
		const after = await meetingCallState(page);
		const ok = expect(after);
		steps.push({ control: name, status: ok ? 'OK' : 'NO_EFFECT', before, after });
		return ok;
	};

	// --- join: the page's own join control (or hook) ---
	const joinHook = await page.evaluate(() => typeof globalThis.__qaseMeetingControls?.join === 'function');
	if (joinSelector || joinHook) {
		await clickControl('join', joinSelector || null, state => state.joined === true && state.active === true);
	} else {
		const state = await meetingCallState(page);
		steps.push({ control: 'join', status: 'UNRESOLVED', reason: 'No join selector supplied and no __qaseMeetingControls.join hook registered by the page.', before: state, after: state });
	}

	for (const control of order) {
		if (control === 'join') continue;
		const resolved = await resolveMeetingControl(page, control);
		if (!resolved) {
			const state = await meetingCallState(page);
			steps.push({ control, status: 'UNRESOLVED', reason: `No visible control matching ${JSON.stringify(MEETING_CONTROL_KEYWORDS[control])} found on the page.`, before: state, after: state });
			continue;
		}
		const expects = {
			mute: state => state.audioEnabled === false,
			unmute: state => state.audioEnabled === true,
			cameraOff: state => state.videoEnabled === false,
			cameraOn: state => state.videoEnabled === true,
			leave: state => state.joined === false || state.active === false
		};
		await clickControl(control, resolved.selector, expects[control]);
	}

	return {
		steps,
		callState: await meetingCallState(page),
		limitations: 'Controls were driven on the page under test with synthetic media devices; no remote attendee or real network audio was involved.'
	};
}

/**
 * Permission-denial recovery workflow: set media permission DENIED, have the
 * page attempt capture (via its own request control/hook), verify the
 * denial is observable, re-grant, retry, and verify the stream resumes.
 */
export async function verifyPermissionRecovery(page, setPermission, { requestSelector, targets = ['camera', 'microphone'] } = {}) {
	const steps = [];
	const readLedger = () => page.evaluate(() => {
		const ledger = document.querySelector('[data-state]#fixture-media-ledger');
		return ledger ? ledger.dataset.state : null;
	}).catch(() => null);

	const attemptCapture = async () => {
		const hook = await page.evaluate(() => typeof globalThis.__qaseMeetingControls?.requestMedia === 'function');
		if (requestSelector) {
			await page.click(requestSelector).catch(() => {});
		} else if (hook) {
			await page.evaluate(() => globalThis.__qaseMeetingControls.requestMedia()).catch(() => {});
		} else {
			await page.evaluate(() => globalThis.__qaseMediaEvidence && 0).catch(() => {});
		}
		await page.waitForTimeout(400);
	};

	// 1. Deny, request, observe.
	await setPermission('denied');
	await attemptCapture();
	const deniedState = await meetingCallState(page);
	const deniedLedger = await readLedger();
	steps.push({ step: 'deny+request', permission: 'denied', callState: deniedState, pageLedger: deniedLedger });

	// 2. Re-grant, retry, observe.
	await setPermission('granted');
	await attemptCapture();
	const grantedState = await meetingCallState(page);
	const grantedLedger = await readLedger();
	steps.push({ step: 'grant+retry', permission: 'granted', callState: grantedState, pageLedger: grantedLedger });

	const deniedObservable = deniedState.joined === false || (deniedLedger ?? '').startsWith('denied');
	const recovered = grantedState.joined === true && grantedState.active === true;
	return {
		steps,
		deniedObservable,
		recovered,
		verdict: deniedObservable && recovered ? 'RECOVERED' : (deniedObservable ? 'NOT_RECOVERED' : 'INCONCLUSIVE'),
		note: 'verdict NOT_RECOVERED reproduces the known recovery defect when the page re-grants but never resumes.'
	};
}
