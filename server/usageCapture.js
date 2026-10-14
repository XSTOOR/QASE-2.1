/**
 * Token usage capture.
 *
 * The vendored @cleanslate/sdk normalizes provider-reported usage
 * ({inputTokens, outputTokens, totalTokens, cachedInputTokens}) but never
 * forwards it to agent streams: CleanSlateService.parseProviderPartStream
 * consumes `{type:'usage'}` events internally and only hands them to
 * logProviderReportedUsage, which logs them for Azure providers and drops
 * them for everyone else.
 *
 * Both capture points below are instance-level and fail safe: if the SDK
 * internals move, no usage is recorded and the run is unaffected.
 */

const AZURE_USAGE_LINE = /\[CleanSlateAzureDebug\].*?reportedInputTokens=(\d+|unknown).*?reportedOutputTokens=(\d+|unknown).*?reportedTotalTokens=(\d+|unknown)(?:.*?cachedInputTokens=(\d+|unknown))?/;
const STAGE_COMPLETE_LINE = /\[CleanSlateService\].*?stage=complete .*?estimatedInputTokens=(\d+).*?estimatedOutputTokens=(\d+)/;

function numberOrUndefined(match, group) {
	const value = match?.[group];
	return value && value !== 'unknown' ? Number(value) : undefined;
}

/** Parses the Azure-only `[CleanSlateAzureDebug] ... reported*Tokens=` info line. */
export function parseAzureUsageLine(line) {
	const match = typeof line === 'string' ? line.match(AZURE_USAGE_LINE) : undefined;
	if (!match) return undefined;
	return {
		inputTokens: numberOrUndefined(match, 1),
		outputTokens: numberOrUndefined(match, 2),
		totalTokens: numberOrUndefined(match, 3),
		cachedInputTokens: numberOrUndefined(match, 4)
	};
}

/**
 * Parses the SDK's stage=complete debug line. These values are estimates
 * (output is ceil(chars/4), input is the SDK's own approximation), so they are
 * only used when no real provider report arrived for the turn.
 */
export function parseStageCompleteLine(line) {
	const match = typeof line === 'string' ? line.match(STAGE_COMPLETE_LINE) : undefined;
	if (!match) return undefined;
	return { inputTokens: Number(match[1]), outputTokens: Number(match[2]), estimated: true };
}

/** Sums usage components; the total is recomputed from the parts. */
export function sumUsage(usageList) {
	const meaningful = usageList.filter(Boolean);
	if (meaningful.length === 0) return undefined;
	const sum = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
	for (const usage of meaningful) {
		sum.inputTokens += usage.inputTokens ?? 0;
		sum.outputTokens += usage.outputTokens ?? 0;
		sum.cachedInputTokens += usage.cachedInputTokens ?? 0;
	}
	sum.totalTokens = sum.inputTokens + sum.outputTokens;
	return sum;
}

/**
 * Folds one provider call's usage into the run's accumulated totals.
 * Real reports always win: estimates are discarded once a real value was seen.
 */
export function applyUsage(current, incoming) {
	if (!incoming) return current;
	const real = incoming.estimated !== true;
	if (!real && current && current.estimated === false) {
		return current;
	}
	const base = current ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
	const inputTokens = base.inputTokens + (incoming.inputTokens ?? 0);
	const outputTokens = base.outputTokens + (incoming.outputTokens ?? 0);
	const cachedInputTokens = base.cachedInputTokens + (incoming.cachedInputTokens ?? 0);
	return {
		inputTokens,
		outputTokens,
		cachedInputTokens,
		totalTokens: inputTokens + outputTokens,
		estimated: real ? false : (base.estimated ?? true),
		updatedAt: Date.now()
	};
}

/**
 * Rolls an already-committed estimate back out of the run's totals, before a
 * real provider report for the same call is applied in its place. Clamped at
 * zero so a rollback can never drive totals negative. The `estimated` flag is
 * recomputed: once nothing estimated-only remains, totals are real.
 */
export function subtractUsage(current, delta) {
	if (!current || !delta) return current;
	return {
		...current,
		inputTokens: Math.max(0, current.inputTokens - (delta.inputTokens ?? 0)),
		outputTokens: Math.max(0, current.outputTokens - (delta.outputTokens ?? 0)),
		cachedInputTokens: Math.max(0, (current.cachedInputTokens ?? 0) - (delta.cachedInputTokens ?? 0))
	};
}

/**
 * Runaway-empty-completion guard (#16225 follow-up).
 *
 * A model gateway can degrade into serving EMPTY completions — every call
 * bills input tokens and returns outputTokens: 0 — while the agent runtime
 * treats each empty response as "continue with another turn". The result is
 * an unbounded loop (~1 turn / 2s, 27k input tokens each) that starves the
 * matrix orchestrator's global execution budget until the item's 20-minute
 * timeout. The config-time probe cannot catch this (a tiny max_tokens=20
 * completion succeeds), so it must be caught at run time.
 *
 * The guard observes REAL provider usage reports (estimates are never model
 * truth): a report counts as "empty" only when it definitely billed input
 * (inputTokens > 0) and produced no output (outputTokens === 0). N
 * consecutive empty reports breach the limit; any non-empty report resets
 * the streak. Breaches re-fire on subsequent empties — the caller's abort is
 * expected to be idempotent.
 */
export function createEmptyOutputGuard({ limit, estimateLimit, onBreach } = {}) {
	const effectiveLimit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
	// #16228: some gateways (z-ai/glm-5.2 via llm.drytis.ai) NEVER report real
	// in-stream usage — every report arrives as estimated:true. The real-report
	// streak above is then permanently blind and runaway empty loops spin for
	// hours (4M+ input tokens per run observed in production). Track a second,
	// higher-threshold streak over estimated zero-output reports so degraded
	// gateways are still stopped — the threshold is deliberately looser because
	// estimates are noisier than provider truth.
	const effectiveEstimateLimit = Number.isFinite(estimateLimit) && estimateLimit >= 1
		? Math.floor(estimateLimit) : Infinity;
	let streak = 0;
	let estimateStreak = 0;
	return {
		/** Feed one harvested usage report. Returns the running streak. */
		observe(usage) {
			if (!usage || typeof usage !== 'object') return streak;
			if (!(usage.inputTokens > 0)) return streak; // no billed input → not a completion
			if ((usage.outputTokens ?? 0) === 0) {
				if (usage.estimated === true) {
					// Estimates are not model truth — only the looser second
					// streak counts them, never the strict one.
					estimateStreak += 1;
					if (estimateStreak >= effectiveEstimateLimit && typeof onBreach === 'function') {
						try {
							onBreach(usage);
						} catch {
							// The guard must never break the usage pipeline.
						}
					}
					return streak;
				}
				streak += 1;
				if (streak >= effectiveLimit && typeof onBreach === 'function') {
					try {
						onBreach(usage);
					} catch {
						// The guard must never break the usage pipeline.
					}
				}
			} else {
				streak = 0;
				estimateStreak = 0;
			}
			return streak;
		},
		/** Current consecutive-empty count (for diagnostics/tests). */
		emptyStreak() {
			return streak;
		},
		/** Current consecutive estimated-empty count (#16228 diagnostics/tests). */
		estimatedEmptyStreak() {
			return estimateStreak;
		}
	};
}

/**
 * Wraps a usage harvest so every model call is counted exactly once.
 *
 * Each real provider report and each estimate gets a unique call id. Reports
 * with an id that was already folded into the run totals are dropped, so a
 * duplicated capture (SDK retry republishing the same report, event replay)
 * can never double-count. Idempotency is keyed per record (i.e. per run).
 */
export function createUsageLedger() {
	const processed = new Set();
	// Reports harvested from the SDK carry no call id of their own, so one is
	// minted per object. Remembering it on the object means the SAME report
	// surfaced again (SDK retry republishing, harvest re-entry) reuses its id
	// and is dropped below instead of being minted a fresh, uncountable id.
	const minted = new WeakMap();
	let sequence = 0;
	return {
		/** Wraps an incoming usage object with a fresh unique call id. */
		track(usage) {
			if (!usage || typeof usage !== 'object') return undefined;
			let callId = typeof usage.callId === 'string' ? usage.callId : minted.get(usage);
			if (!callId) {
				callId = `call-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2, 8)}`;
				minted.set(usage, callId);
			}
			if (processed.has(callId)) return undefined;
			processed.add(callId);
			return { ...usage, callId };
		},
		has(callId) {
			return processed.has(callId);
		},
		get size() {
			return processed.size;
		}
	};
}

/**
 * Wraps `service.logProviderReportedUsage` so every provider call's usage is
 * observed before the SDK drops it. Returns a release function that restores
 * the original method.
 */
export function attachUsageCapture(service, { onUsage } = {}) {
	if (!service || typeof service.logProviderReportedUsage !== 'function' || typeof onUsage !== 'function') {
		return () => undefined;
	}
	const original = service.logProviderReportedUsage.bind(service);
	service.logProviderReportedUsage = (diagnostics, usage) => {
		try {
			if (usage && typeof usage === 'object') onUsage(usage);
		} catch {
			// Usage capture must never break a model turn.
		}
		return original(diagnostics, usage);
	};
	return () => {
		service.logProviderReportedUsage = original;
	};
}

/**
 * Injectable SDK logger that harvests the SDK's own usage log lines.
 *
 * Only the stage=complete estimate line is harvested here: real provider
 * reports are captured by attachUsageCapture (which fires for every provider
 * before the SDK drops the usage). The Azure debug info line carries the SAME
 * report, so harvesting both would double-count Azure runs — this logger
 * deliberately ignores it.
 */
export function createUsageLogger({ onEstimate } = {}) {
	const passthrough = level => (...args) => {
		if (typeof onEstimate !== 'function') return;
		for (const arg of args) {
			if (typeof arg !== 'string') continue;
			const estimate = parseStageCompleteLine(arg);
			if (estimate) onEstimate(estimate);
		}
	};
	return {
		info: passthrough('info'),
		debug: passthrough('debug'),
		error: () => undefined,
		warn: () => undefined,
		trace: () => undefined
	};
}
