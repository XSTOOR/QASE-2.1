/** Bounded browser-only capabilities absent from the upstream SDK registry. */
import { SECURITY_CHECK_IDS } from './securityChecks.js';
import { INTERACTION_ACTIONS } from './interactionApi.js';

export function createBrowserTools(getBridge) {
	return [
		{
			name: 'security_check',
			category: 'browser',
			description: `Runs deterministic, benign security checks against the CURRENT page: security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy), session cookie flags, reflected-XSS escaping (submits a harmless canary through the page's own search form), SQL-injection error signatures (benign quote payload only), and mixed content. Every failed check is reported through report_finding with category "security", the check's evidence and remediation. This is a surface scan, not a penetration test: report findings honestly, including "info" results. Optionally pass a subset of check ids: ${SECURITY_CHECK_IDS.join(', ')}.`,
			parametersSchema: {
				type: 'object', additionalProperties: false,
				properties: {
					checks: {
						type: 'array',
						items: { type: 'string', enum: SECURITY_CHECK_IDS },
						description: 'Optional subset of checks; omit to run all.'
					}
				}
			},
			async run(input) {
				if (input?.checks !== undefined
					&& (!Array.isArray(input.checks) || input.checks.some(id => !SECURITY_CHECK_IDS.includes(id)))) {
					return { success: false, error: `checks must be a subset of: ${SECURITY_CHECK_IDS.join(', ')}.` };
				}
				return getBridge().runSecurityChecks({ checks: input?.checks });
			}
		},
		{
			name: 'browser_media',
			category: 'browser',
			description: 'Tests camera, microphone and screen-share access with synthetic Chromium media only. inspect reads app capture requests and track state; set_permission sets this page origin to granted, denied, or prompt (target microphone, camera or screen_capture); probe briefly checks microphone capture and signal then releases its tracks; probe_camera verifies a real video frame from the synthetic camera; probe_screen_share verifies a virtual-desktop capture track; call_controls reads the application-owned stream state; meeting_controls drives the page join/mute/unmute/camera/leave controls with per-control real track-state evidence; meeting_recovery runs deny → request → re-grant → retry through the real browser permission layer and reports whether the page\'s call recovers (NOT_RECOVERED is a genuine page defect). Non-Chromium engines report capability UNAVAILABLE with the exact reason — a gap, never a pass. Exercise the app camera/mic/meeting controls separately and inspect their actual capture evidence. This never verifies physical hardware or remote meeting audio.',
			parametersSchema: {
				type: 'object', additionalProperties: false,
				properties: {
					action: { type: 'string', enum: ['inspect', 'set_permission', 'probe', 'probe_camera', 'probe_screen_share', 'call_controls', 'meeting_controls', 'meeting_recovery'] },
					permission: { type: 'string', enum: ['granted', 'denied', 'prompt'] },
					target: { type: 'string', enum: ['microphone', 'camera', 'screen_capture'], description: 'Permission target for set_permission (default microphone).' },
					durationMs: { type: 'integer', minimum: 100, maximum: 3000 },
					joinSelector: { type: 'string', description: 'meeting_controls: selector for the page\'s own join button (otherwise a __qaseMeetingControls.join hook is used).' },
					requestSelector: { type: 'string', description: 'meeting_recovery: selector for the page\'s own media-request button driven through the deny→grant flow.' },
					controls: { type: 'array', items: { type: 'string', enum: ['mute', 'unmute', 'cameraOff', 'cameraOn', 'leave'] }, description: 'meeting_controls: controls to drive in order (default all).' },
					targets: { type: 'array', items: { type: 'string', enum: ['camera', 'microphone'] }, description: 'meeting_recovery: permissions to deny then re-grant.' }
				},
				required: ['action']
			},
			async run(input) {
				const actions = ['inspect', 'set_permission', 'probe', 'probe_camera', 'probe_screen_share', 'call_controls', 'meeting_controls', 'meeting_recovery'];
				const controls = ['mute', 'unmute', 'cameraOff', 'cameraOn', 'leave'];
				if (!input || !actions.includes(input.action)
					|| (input.action === 'set_permission' && !['granted', 'denied', 'prompt'].includes(input.permission))
					|| (input.target !== undefined && !['microphone', 'camera', 'screen_capture'].includes(input.target))
					|| (input.durationMs !== undefined && (!Number.isInteger(input.durationMs) || input.durationMs < 100 || input.durationMs > 3000))
					|| (input.controls !== undefined && (!Array.isArray(input.controls) || input.controls.some(control => !controls.includes(control))))
					|| (input.targets !== undefined && (!Array.isArray(input.targets) || input.targets.some(target => !['camera', 'microphone'].includes(target))))
					|| (input.joinSelector !== undefined && (typeof input.joinSelector !== 'string' || input.joinSelector.length > 512))
					|| (input.requestSelector !== undefined && (typeof input.requestSelector !== 'string' || input.requestSelector.length > 512))) {
					return { success: false, error: 'Use inspect, set_permission with granted/denied/prompt (target microphone|camera|screen_capture), probe, probe_camera, probe_screen_share with durationMs 100–3000, call_controls, meeting_controls (joinSelector/controls) or meeting_recovery (requestSelector/targets).' };
				}
				return getBridge().media(input);
			}
		},
		{
			name: 'browser_interaction',
			category: 'browser',
			description: `Executes real device-appropriate input against the LIVE context using the driver's real input injection (touchscreen / mouse / keyboard / wheel / locator drag) — never synthetic DOM events. Input mode follows the context's actual touch capability: touch contexts get driver touchscreen taps; mouse contexts get mouse input, and touch-only gestures report an explicit error instead of pretending. Actions: ${INTERACTION_ACTIONS.join(', ')}, plus "capabilities" to report what the current context honestly supports (with the live orientation). rotate is SKIPPED (not failed) on non-touch contexts. upload takes real file paths via setInputFiles.`,
			parametersSchema: {
				type: 'object', additionalProperties: false,
				properties: {
					action: { type: 'string', enum: [...INTERACTION_ACTIONS, 'capabilities'] },
					target: { type: 'string', description: 'Selector or "#id" for the gesture target (tap/click/drag start etc.).' },
					from: { type: 'string', description: 'drag_to source selector.' },
					to: { type: 'string', description: 'drag_to destination selector.' },
					direction: { type: 'string', enum: ['left', 'right', 'up', 'down'], description: 'swipe/scroll direction (scroll supports up/down).' },
					distance: { type: 'integer', minimum: 20, maximum: 2000, description: 'swipe travel distance in px.' },
					amount: { type: 'integer', minimum: 20, maximum: 5000, description: 'scroll amount in px.' },
					durationMs: { type: 'integer', minimum: 200, maximum: 5000, description: 'long_press hold duration.' },
					text: { type: 'string', description: 'text to type().' },
					key: { type: 'string', description: 'key name to press (e.g. Enter, Tab).' },
					button: { type: 'string', enum: ['left', 'right', 'middle'] },
					files: { type: 'array', items: { type: 'string' }, description: 'file paths for upload (file input target required).' },
					orientation: { type: 'string', enum: ['portrait', 'landscape'] }
				},
				required: ['action']
			},
			async run(input) {
				if (!input || typeof input.action !== 'string' || !input.action.trim()) {
					return { success: false, error: 'Provide an action.' };
				}
				if (input.files !== undefined && (!Array.isArray(input.files) || input.files.some(f => typeof f !== 'string'))) {
					return { success: false, error: 'files must be an array of file paths.' };
				}
				return getBridge().interact(input.action, input);
			}
		},
		{
			name: 'browser_test_meeting_link',
			category: 'browser',
			description: 'Opens a meeting link actually present in the current page in a tracked tab and reports its landing/prejoin state. Supply the observed anchor selector or exact href. Supported external meeting links get a narrowly scoped navigation grant; unrelated origins remain blocked. Inspect the destination and report login, expired link, permission, native-app, or network blockers honestly. Never claims a participant joined or audio reached another attendee.',
			parametersSchema: {
				type: 'object', additionalProperties: false,
				properties: {
					selector: { type: 'string', description: 'Selector for the meeting anchor from a fresh snapshot.' },
					url: { type: 'string', description: 'Exact href of a meeting anchor observed on the current page.' }
				}
			},
			async run(input) {
				if (!input || !['selector', 'url'].some(key => typeof input[key] === 'string' && input[key].trim())
					|| ['selector', 'url'].some(key => input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 8192))) {
					return { success: false, error: 'Provide the selector or exact URL of an observed meeting link.' };
				}
				return getBridge().testMeetingLink(input);
			}
		}
	];
}
