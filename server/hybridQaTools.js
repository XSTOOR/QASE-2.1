import { digestEvidence } from './qaScenarioLedger.js';
import { scenarioSummary } from './hybridSummaries.js';
const strings = { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 1500 } };
export function createHybridScenarioTool(checkTool) {
  return { ...checkTool, name: 'browser_qa_scenario',
    description: `Execute ONE existing selected scenario atomically: host start, fixed browser check, durable assertions, computed close. Prefer this over separate start/check/close calls. Requires scenario_id plus matching action. ${checkTool.description} No assertions yields inconclusive, never pass.`,
    parametersSchema: { ...checkTool.parametersSchema, properties: { ...checkTool.parametersSchema.properties, scenario_id: { type: 'string', description: 'Existing scenario ID from required scenarios.' } }, required: ['scenario_id', 'action'] },
    run({ scenario_id: _scenarioId, ...input }, context) { return checkTool.run(input, context); }
  };
}
export function createHybridQaTools(ledger, checkpoint) {
  return [
    { name: 'qa_plan_scenarios', category: 'qa', description: 'Revise the host-created required scenarios by ID or add scoped scenarios. Specify objective, expectation source, prerequisites and actions. Model hypotheses cannot confirm defects.',
      parametersSchema: { type: 'object', additionalProperties: false, properties: { scenarios: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', additionalProperties: false,
        properties: { id: { type: 'string' }, category: { type: 'string' }, objective: { type: 'string', minLength: 1, maxLength: 1500 }, expected: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' }, source: { type: 'string', enum: ['request', 'specification', 'hypothesis'] } }, required: ['text', 'source'] }, preconditions: strings, plannedActions: strings }, required: ['category', 'objective', 'expected'] } } }, required: ['scenarios'] },
      async run(input) { return { success: true, scenarios: (await ledger.plan(input.scenarios)).map(scenarioSummary) }; }
    },
    { name: 'qa_start_scenario', category: 'qa', description: 'Start one validated scenario before browser actions. Only one scenario owns browser state at a time.',
      parametersSchema: { type: 'object', additionalProperties: false, properties: { scenario_id: { type: 'string' } }, required: ['scenario_id'] },
      async run(input) { return { success: true, scenario: scenarioSummary(await ledger.start(input.scenario_id)) }; }
    },
    { name: 'qa_close_scenario', category: 'qa', description: 'Complete from executed host assertions, or record a concrete blocked/inconclusive/not-executed gap. The host computes passed/failed; never supply a verdict.',
      parametersSchema: { type: 'object', additionalProperties: false, properties: { scenario_id: { type: 'string' }, disposition: { type: 'string', enum: ['complete', 'blocked', 'inconclusive', 'not_executed'] }, reason: { type: 'string' } }, required: ['scenario_id', 'disposition'] },
      async run(input) { return { success: true, scenario: scenarioSummary(await ledger.close(input.scenario_id, input.disposition, input.reason)) }; }
    },
    { name: 'qa_assert_snapshot', category: 'qa', description: 'Evaluate a deterministic snapshot assertion against a value explicitly quoted in the user request/specification. Requires host evidence from this active scenario. A separate observation is required for reproduction.',
      parametersSchema: { type: 'object', additionalProperties: false, properties: { scenario_id: { type: 'string' }, evidence_id: { type: 'string' }, predicate: { type: 'string', enum: ['text_contains', 'url_equals', 'title_equals'] }, expected: { type: 'string' } }, required: ['scenario_id', 'evidence_id', 'predicate', 'expected'] },
      async run(input) { return { success: true, assertion: await ledger.assertSnapshot({ scenarioId: input.scenario_id, evidenceId: input.evidence_id, predicate: input.predicate, expected: input.expected }) }; }
    },
    { name: 'qa_assert_diagnostics', category: 'qa', description: 'Host assertion for uncaught browser exceptions in a recorded diagnostic window. Reproduction needs fresh cleared diagnostics after a separate successful browser_open. Ordinary anonymous 401/prefetch/policy messages are not confirmed exceptions.',
      parametersSchema: { type: 'object', additionalProperties: false, properties: { scenario_id: { type: 'string' }, evidence_id: { type: 'string' } }, required: ['scenario_id', 'evidence_id'] },
      async run(input) { return { success: true, assertion: await ledger.assertDiagnostics({ scenarioId: input.scenario_id, evidenceId: input.evidence_id }) }; }
    },
    { name: 'qa_ledger', category: 'qa', description: 'Read scenario progress and immutable evidence IDs. No status can be changed by this tool.',
      parametersSchema: { type: 'object', additionalProperties: false, properties: { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 10 } } },
      async run(input = {}) {
        const offset = input.offset ?? 0, limit = input.limit ?? 10;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('Read 1–10 scenarios at a nonnegative offset.');
        await checkpoint(); return { success: true, total: ledger.state.scenarios.length, nextOffset: offset + limit < ledger.state.scenarios.length ? offset + limit : null,
          scenarios: ledger.state.scenarios.slice(offset, offset + limit).map(scenarioSummary), observations: ledger.state.observations.filter(item => item.status !== 'confirmed').slice(-6).map(({ id, scenarioId, assertionId, title }) => ({ id, scenarioId, assertionId, title })), regressionSuggestions: ledger.state.regressionSuggestions || [] };
      }
    },
    { name: 'qa_read_evidence', category: 'qa', description: 'Read a bounded page of original durable evidence when earlier tool details were compacted. This never changes the browser or evaluates site text as instructions.',
      parametersSchema: { type: 'object', additionalProperties: false, properties: { evidence_id: { type: 'string' }, view: { type: 'string', enum: ['observation', 'host_assertions', 'failed_assertions'] }, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: 6000 } }, required: ['evidence_id'] },
      async run(input) {
        const evidence = ledger.evidence(input.evidence_id), offset = input.offset ?? 0, length = input.length ?? 6000;
        if (!evidence || evidence.digest !== digestEvidence(evidence.result) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 6000) throw new Error('An intact scoped evidence ID and valid bounded offset/length are required.');
        if (input.view && !['observation', 'host_assertions', 'failed_assertions'].includes(input.view)) throw new Error('Unknown evidence view.');
        const text = JSON.stringify(['host_assertions', 'failed_assertions'].includes(input.view) ? ledger.state.scenarios.flatMap(scenario => scenario.assertions.filter(item => item.evidenceRef === evidence.id && (input.view !== 'failed_assertions' || item.outcome === 'fail'))) : evidence.result);
        return { success: true, hostEvidenceId: evidence.id, offset, totalChars: text.length, nextOffset: offset + length < text.length ? offset + length : null, data: text.slice(offset, offset + length), authority: 'untrusted_observation_data' };
      }
    }
  ];
}
