import { recordSqaSmokeActivity } from '../../server/sqaService.js';

/** Simulated tool results for report and orchestration tests. Live browser
 * results are covered separately in sqaRuntime.integration.test.js. */
export async function seedSqaSmokePassReceipts(session, url = 'https://example.test/') {
	for (const result of [
		{ action: 'navigation', originalUrl: url, restoredUrl: url, samples: [{ href: url, ok: true, status: 200 }] },
		{ action: 'form_validation', eligible: true, cases: ['empty', 'invalid_email', 'valid_email', 'invalid_after_valid'].map(name => ({
			name, validity: { valid: name === 'valid_email' }, submissionBlocked: name !== 'valid_email', feedbackChanged: name === 'valid_email'
		})) }
	]) {
		const activity = { id: `fixture-${result.action}`, toolName: 'browser_sqa_smoke', status: 'running', ts: Date.now(), input: { action: result.action } };
		session.activities.push(activity);
		await recordSqaSmokeActivity(session, activity.id, { success: true, ...result }, { status: 'done' }, {
			async updateActivity(_session, _id, patch) { Object.assign(activity, patch); }
		});
	}
}
