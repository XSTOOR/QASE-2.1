/** Bounded browser-only capabilities absent from the upstream SDK registry. */
export function createBrowserTools(getBridge) {
	return [
		{
			name: 'browser_media',
			category: 'browser',
			description: 'Tests microphone access with synthetic Chromium audio only. inspect reads app capture requests and track state; set_permission sets this page origin to granted, denied, or prompt; probe briefly checks capture and signal then releases its tracks. Exercise the app microphone controls separately and inspect their actual capture evidence. This never verifies physical hardware or remote meeting audio.',
			parametersSchema: {
				type: 'object', additionalProperties: false,
				properties: {
					action: { type: 'string', enum: ['inspect', 'set_permission', 'probe'] },
					permission: { type: 'string', enum: ['granted', 'denied', 'prompt'] },
					durationMs: { type: 'integer', minimum: 100, maximum: 3000 }
				},
				required: ['action']
			},
			async run(input) {
				if (!input || !['inspect', 'set_permission', 'probe'].includes(input.action)
					|| (input.action === 'set_permission' && !['granted', 'denied', 'prompt'].includes(input.permission))
					|| (input.durationMs !== undefined && (!Number.isInteger(input.durationMs) || input.durationMs < 100 || input.durationMs > 3000))) {
					return { success: false, error: 'Use inspect, set_permission with granted/denied/prompt, or probe with durationMs between 100 and 3000.' };
				}
				return getBridge().media(input);
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
