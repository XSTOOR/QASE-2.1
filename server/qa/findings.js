/**
 * Candidate defects.
 *
 * Every detector, the exploring agent and the visual reviewer produce
 * candidates in this one shape. Triage later verifies, merges and promotes
 * them to findings. Keeping a single shape is what lets the report, the fix
 * prompts and the dashboard stay simple.
 */
import { createHash, randomUUID } from 'node:crypto';

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
export const CATEGORIES = ['functional', 'navigation', 'forms', 'layout', 'visual', 'animation', 'responsive', 'accessibility', 'performance', 'console', 'network', 'content', 'security', 'seo'];

const text = (value, max = 2000) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function pathOf(url) {
	try {
		const parsed = new URL(url);
		return parsed.pathname.replace(/\/\d+(?=\/|$)/g, '/:id') || '/';
	} catch { return ''; }
}

/**
 * Normalizes a raw detector result into a candidate.
 * Required: detector, title, actual. Everything else has a safe default.
 */
export function candidate(input) {
	const severity = SEVERITIES.includes(input.severity) ? input.severity : 'medium';
	const category = CATEGORIES.includes(input.category) ? input.category : 'functional';
	const confidence = Math.max(0, Math.min(1, Number.isFinite(input.confidence) ? input.confidence : 0.7));
	const result = {
		id: input.id ?? randomUUID(),
		source: input.source ?? 'detector',
		detector: text(input.detector, 80) || 'unknown',
		category,
		severity,
		confidence,
		title: text(input.title, 240),
		url: text(input.url, 2000),
		viewport: text(input.viewport, 60) || undefined,
		selector: text(input.selector, 500) || undefined,
		expected: text(input.expected, 1500),
		actual: text(input.actual, 2500),
		evidence: text(input.evidence, 4000) || undefined,
		steps: Array.isArray(input.steps) ? input.steps.map(step => text(step, 400)).filter(Boolean).slice(0, 12) : [],
		fix: text(input.fix, 2500) || undefined,
		artifactId: input.artifactId,
		data: input.data && typeof input.data === 'object' ? input.data : undefined,
		ts: Date.now()
	};
	result.fingerprint = input.fingerprint ?? fingerprint(result);
	return result;
}

/** Same defect across viewports or repeated pages collapses to one key. */
export function fingerprint(item) {
	const scope = item.data?.siteWide ? 'site' : pathOf(item.url);
	const selector = item.data?.siteWide || item.data?.ignoreSelector ? '' : text(item.selector, 200).toLowerCase();
	const key = [item.detector, item.category, scope, selector, text(item.data?.key ?? item.title, 200).toLowerCase()].join('|');
	return createHash('sha256').update(key).digest('hex').slice(0, 24);
}

/** Merges duplicates, keeping the strongest evidence and every viewport seen. */
export function mergeCandidates(items) {
	const byKey = new Map();
	for (const item of items) {
		const existing = byKey.get(item.fingerprint);
		if (!existing) {
			byKey.set(item.fingerprint, { ...item, viewports: item.viewport ? [item.viewport] : [], occurrences: 1, urls: item.url ? [item.url] : [] });
			continue;
		}
		existing.occurrences++;
		if (item.viewport && !existing.viewports.includes(item.viewport)) existing.viewports.push(item.viewport);
		if (item.url && !existing.urls.includes(item.url) && existing.urls.length < 10) existing.urls.push(item.url);
		if (SEVERITIES.indexOf(item.severity) < SEVERITIES.indexOf(existing.severity)) existing.severity = item.severity;
		existing.confidence = Math.max(existing.confidence, item.confidence);
		if (!existing.artifactId && item.artifactId) existing.artifactId = item.artifactId;
		if (!existing.evidence && item.evidence) existing.evidence = item.evidence;
	}
	return [...byKey.values()];
}

export function severityRank(severity) {
	const index = SEVERITIES.indexOf(severity);
	return index < 0 ? SEVERITIES.length : index;
}
