import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalModeHash } from './modeIntegrity.js';
import { redact } from './secrets.js';

export const FOUNDER_PAGE_REVIEW = 'browser_founder_review';
const TEXT_SAMPLE = { limit: 5000 };
const SAMPLE_STEPS = [['browser_snapshot', { limit: 40 }], ['browser_read_page', TEXT_SAMPLE]];
const PRIMARY_STEPS = [...SAMPLE_STEPS, ['browser_qa_check', { action: 'accessibility' }], ['browser_qa_check', { action: 'responsive' }], ['browser_diagnostics', {}]];

function pageTextKey(result) {
	if (result?.success !== true || typeof result.text !== 'string' || !Number.isInteger(result.totalCharacters)) return undefined;
	const sample = [result.title, result.text, result.totalCharacters, result.complete];
	if (result.tokenRateExcerpts?.length) sample.push(result.tokenRateExcerpts);
	return canonicalModeHash(sample);
}

/** Use only receipts whose original browser activities still exist in this run. */
export function completedFounderPageReviews(session) {
	const activities = session.activities ?? [];
	const byId = new Map(activities.map(activity => [activity.id, activity]));
	return activities.flatMap(activity => {
		const receipt = activity.founderPageReview;
		if (activity.toolName !== FOUNDER_PAGE_REVIEW || activity.status !== 'done' || receipt?.version !== 1
			|| !['primary', 'supporting'].includes(receipt.depth) || receipt.depth !== activity.input?.depth) return [];
		const steps = receipt.depth === 'primary' ? PRIMARY_STEPS : SAMPLE_STEPS;
		if (!Array.isArray(receipt.checks) || receipt.checks.length !== steps.length || !receipt.checks.every((check, index) => {
			const child = byId.get(check?.activity_id);
			const [name, args] = steps[index];
			return child?.status === 'done' && child.toolName === name && child.input?.action === args.action
				&& check.tool === name && check.action === args.action;
		})) return [];
		return [{ reviewId: activity.id, ...receipt }];
	});
}

function compactResult(tool, result) {
	if (result.success === false) return { success: false, code: result.code, error: result.error ?? result.message };
	if (tool === 'browser_snapshot') {
		const source = result.inventory ?? result;
		return { url: source.url, title: source.title, elements: source.elements?.slice(0, 40), limitation: 'Sample of up to 40 visible elements.' };
	}
	if (tool === 'browser_qa_check') {
		const assertions = result.assertions ?? [];
		const failed = assertions.filter(assertion => assertion.outcome === 'fail');
		return {
			assertionCount: assertions.length, failedCount: failed.length,
			assertions: [...failed, ...assertions.filter(assertion => assertion.outcome !== 'fail')].slice(0, 10),
			skipped: result.skipped, limitations: result.limitations
		};
	}
	if (tool === 'browser_diagnostics') {
		const errors = result.console?.filter(entry => /error|assert/i.test(entry.level || entry.type || '')) ?? [];
		const failures = result.network?.filter(entry => entry.errorText || entry.error || (entry.statusCode ?? entry.status) >= 400) ?? [];
		return { consoleErrorCount: errors.length, failedRequestCount: failures.length, console: errors.slice(-8), network: failures.slice(-8) };
	}
	return result;
}

export function createFounderPageReview(session, { invoke, currentUrl, readCurrentPage, isCancelled }) {
	const owner = new AsyncLocalStorage();
	const token = Symbol('Founder page review');
	let running = false;
	const fail = (error, checks = []) => ({ success: false, error, checks });
	const tool = {
		name: FOUNDER_PAGE_REVIEW, category: 'browser',
		description: 'Review the open page in one call. Both depths sample visible elements and text. Primary also samples accessibility, responsive behavior and diagnostics. Use saved page reviews and their child activity IDs directly. A repeated request on a matching route and rendered text sample returns the earlier IDs. Provide refresh_reason for a material state change outside that sample. Use a focused tool for a missing check or a current locator. Record supported observations promptly.',
		parametersSchema: {
			type: 'object', additionalProperties: false, required: ['depth'],
			properties: {
				depth: { type: 'string', enum: ['primary', 'supporting'] },
				refresh_reason: { type: 'string', minLength: 1, maxLength: 200, description: 'Describe an observed page state change that requires a new sample.' }
			}
		},
		async run(input, context = {}) {
			if (!input || !['primary', 'supporting'].includes(input.depth)
				|| Object.keys(input).some(key => !['depth', 'refresh_reason'].includes(key))
				|| (input.refresh_reason !== undefined && (typeof input.refresh_reason !== 'string' || !input.refresh_reason.trim() || input.refresh_reason.length > 200))) return fail('Choose primary or supporting page review and optionally describe a material state change.');
			if (running || session.activities?.some(activity => activity.toolName !== FOUNDER_PAGE_REVIEW && activity.toolName?.startsWith('browser_') && activity.status === 'running')) return fail('Wait for the active browser action before reviewing the page.');
			const url = currentUrl();
			if (!/^https?:\/\//i.test(url ?? '')) return fail('Open the authorized target page before collecting evidence.');
			const { origin, pathname } = new URL(url);
			const route = redact(session.id, origin + pathname);
			const routeKey = canonicalModeHash(url);
			const saved = completedFounderPageReviews(session);
			const previous = saved.findLast(review => review.routeKey === routeKey && (input.depth === 'supporting' || review.depth === 'primary'));
			const steps = input.depth === 'primary' ? PRIMARY_STEPS : SAMPLE_STEPS;
			const checks = [];
			const cancelled = () => context.signal?.aborted || isCancelled();
			running = true;
			try {
				return await owner.run(token, async () => {
					if (previous?.textKey && !input.refresh_reason && !cancelled()) {
						const sample = await readCurrentPage(TEXT_SAMPLE).catch(() => undefined);
						if (!cancelled() && currentUrl() === url && pageTextKey(sample) === previous.textKey) {
							return {
								success: true, reused: true, route, depth: previous.depth,
								review_id: previous.reviewId, checks: previous.checks,
								summary: 'Saved review matched the current bounded rendered text sample. Cite the original child activity IDs. Use a focused browser check for live controls or missing evidence.'
							};
						}
					}
					if (input.depth === 'primary' && !previous && session.activities?.some(activity => activity.toolName === FOUNDER_PAGE_REVIEW && activity.input?.depth === 'primary' && activity.status === 'done')) {
						return fail('Representative page checks are already saved. Use supporting depth for additional routes or request a specific check.');
					}
					let textKey;
					for (const [name, args] of steps) {
						if (cancelled()) return fail('Page review cancelled. Earlier child results remain saved.', checks);
						if (currentUrl() !== url) return fail('The active page changed during review. Earlier child results remain saved.', checks);
						const child = await invoke(name, args, context.signal);
						if (!child?.activityId || !child.result) return fail('No saved browser receipt returned for a review step.', checks);
						checks.push({ tool: name, action: args.action, activity_id: child.activityId, result: compactResult(name, child.result) });
						if (name === 'browser_snapshot' && child.result.success === false) return fail('The page snapshot failed. Inspect the saved result before continuing.', checks);
						if (name === 'browser_read_page') textKey = pageTextKey(child.result);
					}
					if (cancelled()) return fail('Page review cancelled. Earlier child results remain saved.', checks);
					if (currentUrl() !== url) return fail('The active page changed during review. Earlier child results remain saved.', checks);
					const reviewReceipt = textKey && checks.every(check => check.result.success !== false) ? {
						version: 1, route, routeKey, textKey, depth: input.depth,
						checks: checks.map(({ tool, action, activity_id }) => ({ tool, action, activity_id }))
					} : undefined;
					return { success: true, route, depth: input.depth, checks, reviewReceipt };
				});
			} finally {
				running = false;
			}
		}
	};
	return { tool, dispatchAllowed: () => !running || owner.getStore() === token, isChild: () => owner.getStore() === token };
}
