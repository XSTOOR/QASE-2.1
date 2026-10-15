/**
 * Per-run budget for intrusive security probing.
 *
 * Input-validation and SQL-injection checks submit crafted payloads through
 * the browser. That must never turn into a flood against the target, however
 * enthusiastic the agent gets: every fill/type/submit-shaped browser action
 * while a security check is selected counts against a hard cap, and the guard
 * returns a terminal instruction when the cap is hit (the agent reports the
 * remaining checks as not tested with the reason instead of hammering on).
 *
 * The cap is a safety ceiling, not a tuning knob — env can lower/raise it only
 * within a bounded range (see clampSecurityPayloadLimit in config.js).
 */
import { clampSecurityPayloadLimit } from './config.js';

const SECURITY_PAYLOAD_TOOL_NAMES = new Set([
	'browser_fill',
	'browser_type',
	'browser_key'
]);

/** True when the run's selection includes at least one security check. */
export function runHasSecurityChecks(session) {
	return Array.isArray(session?.selectedTests)
		&& session.selectedTests.some(id => typeof id === 'string' && id.startsWith('security_'));
}

export function countSecurityPayloadActivities(session) {
	return (session?.activities ?? []).filter(activity => (
		typeof activity?.toolName === 'string'
		&& SECURITY_PAYLOAD_TOOL_NAMES.has(activity.toolName)
		&& activity.status !== 'running'
	)).length;
}

/**
 * Wraps payload-carrying browser tools with the security payload cap. Only
 * applies to runs that selected a security check; every other run is untouched.
 */
export function guardSecurityPayloadTool(tool, session, limitOverride) {
	if (!runHasSecurityChecks(session)) return tool;
	if (!SECURITY_PAYLOAD_TOOL_NAMES.has(tool?.name) || typeof tool.run !== 'function') return tool;
	const limit = clampSecurityPayloadLimit(limitOverride);
	return {
		...tool,
		async run(input, context) {
			const used = countSecurityPayloadActivities(session);
			if (used >= limit) {
				return {
					success: false,
					code: 'SECURITY_PAYLOAD_LIMIT_REACHED',
					used,
					limit,
					error: `The per-run security payload limit is reached (${used}/${limit} crafted inputs). Do not submit more crafted payloads. Record any remaining unexecuted security checks as not tested with this reason, then finish the report.`
				};
			}
			return tool.run(input, context);
		}
	};
}
