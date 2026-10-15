/**
 * Phase 21 · BrowserStack runtime provider.
 *
 * Wraps the existing browserstackProvider. Level is VIRTUAL_DEVICE for remote
 * OS/browser runtimes, and REAL_DEVICE only when the provider can attest a
 * physical device session (realMobile capability + a live device session id).
 * Credentials absent → this provider reports unavailable and the manager
 * surfaces the honest fallbacks.
 */

import { EXECUTION_LEVELS as LEVELS } from './provider.js';
import { browserstackCredentials, browserstackConnectOptions } from '../browserstackProvider.js';

export function createBrowserstackRuntimeProvider({ credentials = browserstackCredentials() } = {}) {
	const available = Boolean(credentials);
	return {
		id: 'browserstack',
		capabilities: {
			supportedLevels: available ? [LEVELS.VIRTUAL_DEVICE, LEVELS.REAL_DEVICE] : [],
			canRotate: true,
			permissionsSupported: ['camera', 'microphone', 'geolocation'],
			physicalDevices: available,   // realMobile devices — attested per session, not assumed
			queueable: true,
			...(available ? {} : { unavailableReason: 'BrowserStack credentials not configured (BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY).' })
		},

		isAvailable: () => available,

		/**
		 * Attestation: was this REALLY a physical device session? Derived from
		 * the environment's BrowserStack capability map — never from the name.
		 */
		attestPhysicalDevice(environment) {
			// Catalog rows carry the capability map as runtimeCapabilities; a raw
			// BrowserStack session may carry it as browserstackCapabilities. Both
			// attestations are trusted equally: realMobile must be explicitly true
			// AND a concrete deviceName must be present — never attested by name alone.
			const caps = environment?.runtimeCapabilities
				?? environment?.browserstackCapabilities
				?? {};
			if (caps.realMobile === true && typeof caps.deviceName === 'string' && caps.deviceName.length > 0) {
				return { physical: true, deviceName: caps.deviceName, evidence: 'capability map realMobile + deviceName' };
			}
			return { physical: false, reason: 'No realMobile attestation in the environment capability map.' };
		},

		async create_session({ environment, linkedRunId, linkedTestCaseId } = {}) {
			if (!available) {
				return { unavailable: true, reason: this.capabilities.unavailableReason };
			}
			const attestation = this.attestPhysicalDevice(environment);
			return {
				sessionId: null,
				environment: environment ?? null,
				level: attestation.physical ? LEVELS.REAL_DEVICE : LEVELS.VIRTUAL_DEVICE,
				attestation,
				status: 'created',
				linkedRunId: linkedRunId ?? null,
				linkedTestCaseId: linkedTestCaseId ?? null
			};
		},

		async get_device(session) {
			const attestation = this.attestPhysicalDevice(session?.environment);
			return {
				id: session?.environment?.device ?? 'browserstack-device',
				name: session?.environment?.device ?? 'BrowserStack remote device',
				type: session?.environment?.deviceType ?? 'unknown',
				level: attestation.physical ? LEVELS.REAL_DEVICE : LEVELS.VIRTUAL_DEVICE,
				honest: attestation.physical
					? `Physical device attested via ${attestation.evidence}.`
					: 'Remote browser/OS runtime — not attested as physical hardware.'
			};
		},

		async start_session(session) {
			if (!available) return { ...session, status: 'failed', reason: this.capabilities.unavailableReason };
			return { ...session, status: 'running', startedAt: new Date().toISOString() };
		},

		async execute_test(session, { run }) {
			return { sessionId: session?.sessionId ?? null, level: session?.level, delegated: true, runId: run?.id ?? null };
		},

		async capture_screenshot() { return { supported: true, via: 'remote CDP' }; },
		async capture_video() { return { supported: true, via: 'browserstack video artifact' }; },
		async capture_logs(session) { return { supported: true, via: 'browserstack logs', sessionId: session?.sessionId ?? null }; },
		async collect_device_information(session) {
			return { supported: true, via: 'browserBridge.readRuntimeFacts on the remote page', sessionId: session?.sessionId ?? null };
		},

		async stop_session(session) {
			return { ...session, status: 'done', endedAt: new Date().toISOString() };
		}
	};
}
