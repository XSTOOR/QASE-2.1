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
		let permission = 'unsupported';
		try { permission = (await navigator.permissions.query({ name: 'microphone' })).state; } catch {}
		return {
			secureContext: isSecureContext,
			captureSupported: Boolean(navigator.mediaDevices?.getUserMedia),
			permission,
			requests: globalThis.__qaseMediaEvidence?.read() ?? []
		};
	});
}

const permissionControllers = new WeakMap();

export async function setMicrophonePermission(context, page, permission) {
	// Chrome removes overrides when their CDP session detaches. Keep a browser
	// session alive for this context, including when the selected tab is closed.
	let controller = permissionControllers.get(context);
	if (!controller) {
		controller = (async () => {
			const target = await context.newCDPSession(page);
			let browserContextId;
			try { ({ targetInfo: { browserContextId } } = await target.send('Target.getTargetInfo')); }
			finally { await target.detach(); }
			if (!browserContextId) throw new Error('Microphone permission requires an isolated browser context.');
			const client = await context.browser().newBrowserCDPSession();
			context.once('close', () => { permissionControllers.delete(context); void client.detach().catch(() => {}); });
			return { client, browserContextId };
		})();
		permissionControllers.set(context, controller);
		controller.catch(() => permissionControllers.delete(context));
	}
	const { client, browserContextId } = await controller;
	await client.send('Browser.setPermission', {
		permission: { name: 'microphone' }, setting: permission,
		origin: new URL(page.url()).origin, browserContextId
	});
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
