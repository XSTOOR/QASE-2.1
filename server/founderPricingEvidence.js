import { canonicalModeHash } from './modeIntegrity.js';

const RATE_NAME = String.raw`(?:(?:per[- ]token|token|model(?:[- ]usage)?)\s+(?:rates?|prices?|pricing)|(?:input and output)\s+(?:rates?|prices?))`;
const MISSING_RATE = new RegExp(
	`\\b(?:no|without)\\s+(?:(?:public|visible|published|listed)\\s+)?${RATE_NAME}\\b|`
	+ `\\b${RATE_NAME}\\b[^.!?]{0,40}\\b(?:are|is) (?:missing|absent|unavailable|not (?:visible|listed|published|shown))\\b|`
	+ String.raw`\b(?:model[- ]usage|token) costs?\b[^.!?]{0,40}\bno (?:visible|public|published) rates?\b`, 'i'
);
const PUBLISH_RATE = new RegExp(
	`^\\s*(?:publish|add|list|display)\\s+(?:a\\s+)?(?:(?:public|visible|pre-signup)\\s+)?${RATE_NAME}\\b`, 'i'
);

/** Positive matches come from visible page text. An empty scan does not
 * establish absence across other page states, routes or the product. */
export function founderPricingEvidence(session) {
	const checkpoint = session.founder?.investigationCheckpoint;
	if (checkpoint?.version !== 1 || !Array.isArray(checkpoint.entries)
		|| checkpoint.revision !== canonicalModeHash(checkpoint.entries)) return { hasPageReads: false, observedRates: [] };
	const completedReads = new Set((session.activities ?? [])
		.filter(activity => activity.toolName === 'browser_read_page' && activity.status === 'done')
		.map(activity => activity.id));
	const reads = checkpoint.entries.filter(entry => entry.tool === 'browser_read_page'
		&& entry.textCoverage && completedReads.has(entry.activityId));
	const routes = new Map();
	for (const { activityId, url, tokenRateExcerpts } of reads) {
		if (tokenRateExcerpts?.length) routes.set(url, { activityId, url, excerpts: tokenRateExcerpts });
	}
	return { hasPageReads: reads.length > 0, observedRates: [...routes.values()].slice(-6) };
}

function containsClaim(value, predicate) {
	if (typeof value === 'string') return value.split(/(?<=[.!?])\s+/).some(predicate);
	return value !== null && typeof value === 'object' && Object.values(value).some(item => containsClaim(item, predicate));
}

export function assertFounderPricingClaims(session, value) {
	// Signed-in rates do not establish what a visitor can see before signup.
	if (session.founder?.scope?.access?.decision === 'authenticated') return;
	const { hasPageReads, observedRates } = founderPricingEvidence(session);
	if (!hasPageReads) return; // Legacy runs have no page-coverage receipts.
	const claimsMissing = containsClaim(value, sentence =>
		MISSING_RATE.test(sentence)
		&& !/\b(?:was|were) (?:observed|found|verified) (?:in|within|during)\b/i.test(sentence)
		&& !/^\s*(?:if|assuming)\b/i.test(sentence));
	if (observedRates.length && (claimsMissing || containsClaim(value, sentence => PUBLISH_RATE.test(sentence)))) {
		throw new TypeError('Saved browser evidence already shows token rates. Describe the observed rates or a specific clarity improvement using that evidence.');
	}
	if (claimsMissing) {
		throw new TypeError('The saved page samples do not establish that token rates are absent. Describe which pricing content was reviewed and what remains unverified.');
	}
}
