import { randomUUID } from 'node:crypto';

export function createHybridTelemetry(state, { now = Date.now } = {}) {
  const metrics = state.telemetry ??= { elapsedMs: 0, reasoner: { calls: 0, inputTokens: 0, outputTokens: 0, reservedTokens: 0, latencyMs: 0 }, classifier: { calls: 0, inputTokens: 0, outputTokens: 0, reservedTokens: 0, latencyMs: 0 }, browserActions: 0, toolFailures: 0, classifications: {}, events: [] };
  let began = now(), baseline = metrics.elapsedMs, active = true;
  return {
    metrics,
    browserTiming(name, durationMs) {
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      const timings = metrics.browserTimings ??= {};
      if (!Object.hasOwn(timings, name) && Object.keys(timings).length >= 40) return;
      const item = timings[name] ??= { calls: 0, totalMs: 0, maxMs: 0 };
      item.calls++; item.totalMs += durationMs; item.maxMs = Math.max(item.maxMs, durationMs);
    },
    tick() { if (active) metrics.elapsedMs = baseline + Math.max(0, now() - began); return metrics.elapsedMs; },
    resume() { baseline = metrics.elapsedMs; began = now(); active = true; },
    pause() { this.tick(); active = false; },
    event(type, detail = {}) {
      // Only host-defined summaries belong here, never prompts or reasoning.
      metrics.events.push({ id: randomUUID(), type, ts: now(), ...detail });
      metrics.events = metrics.events.slice(-100);
    },
    usage(role, usage = {}) {
      const target = metrics[role];
      const input = usage.inputTokens ?? usage.input_tokens, output = usage.outputTokens ?? usage.output_tokens;
      if (Number.isInteger(input) && input >= 0 && Number.isInteger(output) && output >= 0) {
        target.inputTokens += input; target.outputTokens += output;
        target.usageReported = true;
      }
      // Use gateway-reported cost only; no guessed price tables.
      if (Number.isFinite(usage.cost) && usage.cost >= 0) target.reportedCost = (target.reportedCost || 0) + usage.cost;
    }
  };
}
