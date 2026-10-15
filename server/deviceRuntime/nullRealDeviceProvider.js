/**
 * Phase 21 · Null real-device provider.
 *
 * The honest placeholder for physical device labs: every request for REAL
 * DEVICE execution returns NOT AVAILABLE FOR REAL EXECUTION until a lab is
 * actually connected. It never fabricates a device, never queues, never
 * pretends.
 */

import { EXECUTION_LEVELS as LEVELS } from './provider.js';

export const NOT_AVAILABLE_FOR_REAL_EXECUTION = 'NOT AVAILABLE FOR REAL EXECUTION';

export function createNullRealDeviceProvider() {
	return {
		id: 'null-real-device',
		capabilities: {
			supportedLevels: [],
			canRotate: false,
			permissionsSupported: [],
			physicalDevices: false,
			queueable: false,
			unavailableReason: 'No physical device lab is connected. Connect a DeviceRuntimeProvider with physicalDevices=true to enable REAL DEVICE execution.'
		},

		isAvailable: () => false,

		async create_session() {
			return { unavailable: true, notAvailable: NOT_AVAILABLE_FOR_REAL_EXECUTION, reason: this.capabilities.unavailableReason };
		},

		async get_device() {
			return { id: 'no-lab', name: 'No physical device lab', level: null, honest: NOT_AVAILABLE_FOR_REAL_EXECUTION };
		},

		async start_session(session) {
			return { ...session, status: 'failed', reason: NOT_AVAILABLE_FOR_REAL_EXECUTION };
		},

		async execute_test() {
			return { unavailable: true, notAvailable: NOT_AVAILABLE_FOR_REAL_EXECUTION };
		},

		async capture_screenshot() { return { supported: false, reason: NOT_AVAILABLE_FOR_REAL_EXECUTION }; },
		async capture_video() { return { supported: false, reason: NOT_AVAILABLE_FOR_REAL_EXECUTION }; },
		async capture_logs() { return { supported: false, reason: NOT_AVAILABLE_FOR_REAL_EXECUTION }; },
		async collect_device_information() { return { supported: false, reason: NOT_AVAILABLE_FOR_REAL_EXECUTION }; },

		async stop_session(session) {
			return { ...session, status: 'failed', reason: NOT_AVAILABLE_FOR_REAL_EXECUTION };
		}
	};
}
