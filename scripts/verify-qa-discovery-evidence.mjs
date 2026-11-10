/** Offline verification of actual qualification checkpoints. Never executes
 * browser actions, model calls, credential handling or database writes. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { applicationDiscoveryStatus } from '../server/qaApplicationDiscovery.js';
import { hybridCompletion, validateHybridFinding, validateHybridReport } from '../server/qaCompletionGate.js';
import { digestEvidence } from '../server/qaScenarioLedger.js';
import { qaScenarioSchedule } from '../server/qaScenarioScheduler.js';
import { scenarioExecutionAccount } from '../server/qaExecutionState.js';

const file=process.argv[2];assert.ok(file,'Provide a saved qualification checkpoint JSON.');
const session=JSON.parse(fs.readFileSync(file,'utf8')),state=session.hybrid;
assert.equal(session.mode,'qa');assert.equal(session.status,'done');assert.ok(session.report);
const discovery=applicationDiscoveryStatus(session);assert.equal(discovery.required,true);assert.equal(discovery.ready,true);
for(const e of state.evidence){assert.equal(e.runId,session.id);assert.equal(e.digest,digestEvidence(e.result));assert.ok(state.actions.some(a=>a.id===e.actionId&&a.evidenceId===e.id));}
for(const s of state.scenarios)for(const a of s.assertions){assert.ok(state.evidence.some(e=>e.id===a.evidenceRef));assert.ok(s.executedActionIds.includes(a.actionId));}
assert.equal(state.actions.some(a=>['running','uncertain'].includes(a.status)),false);
const schedule=qaScenarioSchedule(session,scenarioExecutionAccount);assert.equal(schedule.accounted,schedule.total);assert.equal(schedule.unresolved.length,0);
const report=validateHybridReport(session,{verdict:session.report.verdict});assert.equal(report.verdict,session.report.verdict);
for(const f of session.findings)validateHybridFinding(session,{scenario_id:f.hybridEvidence.scenarioId,assertion_id:f.hybridEvidence.assertionId});
for(const role of ['reasoner','classifier']){assert.equal(state.telemetry[role].reservedTokens,0);assert.equal(state.telemetry[role].usageReported,true);assert.ok(state.modelBudget.roles[role].reservations.every(r=>['settled','not_dispatched'].includes(r.status)));}
const result=hybridCompletion(session),tokens=['reasoner','classifier'].reduce((n,role)=>n+state.telemetry[role].inputTokens+state.telemetry[role].outputTokens,0);
console.log(JSON.stringify({runId:session.id,checkpoint:file,status:session.status,verdict:report.verdict,discovery:{features:discovery.features.length,probes:discovery.probes,observations:discovery.observations},accountability:result.accountability,conclusiveCoverage:result.coverage,counts:result.counts,confirmedDefects:session.findings.length,exactProviderTokens:tokens,tokenEstimatesUsed:false,browserActions:state.telemetry.browserActions,executionMs:state.telemetry.elapsedMs,evidenceReceipts:state.evidence.length,negativeInputCases:state.evidence.reduce((n,e)=>n+(e.result.formTesting?.negativeCases||0),0),verification:'passed'},null,2));
