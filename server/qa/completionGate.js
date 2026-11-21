/**
 * The deterministic completion gate. A run may only be reported "complete"
 * when every check here holds. Nothing a model says (an explorer's "finish",
 * a summary claiming full coverage) can satisfy a check: each one reads the
 * recorded plan, graph, coverage and findings.
 *
 *   complete — every check holds
 *   partial  — the target was tested, but something planned did not run or is inconclusive
 *   blocked  — the target could not be tested at all (unreachable, or auth required and unavailable with nothing public)
 */
import { TERMINAL } from './planner.js';

export function evaluateCompletion({ state, plan, graph, coverageRows = [], findings = [], triaged = false, stopped = false }) {
	const checks = [];
	const check = (id, ok, detail, severity = 'required') => checks.push({ id, ok: Boolean(ok), detail, severity });
	const scenarios = plan?.scenarios ?? [];
	const pages = Object.keys(graph?.pages ?? {}).length;

	check('target_loaded', state.loaded, state.loaded ? `Start page answered HTTP ${state.mainResponse?.status ?? '2xx'}.` : 'The start page did not load.');
	check('observed_before_planning', Boolean(state.observation?.at) && (!plan?.createdAt || state.observation.at <= plan.createdAt), state.observation?.at ? 'The application was observed before the plan was generated.' : 'No observation was recorded.');
	check('graph_built', pages > 0, `${pages} page${pages === 1 ? '' : 's'} in the application graph.`);
	check('plan_generated', scenarios.length > 0, `${scenarios.length} scenarios in ${plan?.revisions?.length ?? 0} plan revision(s).`);
	const open = scenarios.filter(item => !TERMINAL.has(item.state));
	check('every_scenario_terminal', open.length === 0, open.length ? `${open.length} scenario(s) still pending or running.` : 'Every scenario reached a recorded outcome.');
	const notRun = scenarios.filter(item => ['not_executed', 'inconclusive'].includes(item.state));
	check('every_scenario_executed', notRun.length === 0, notRun.length ? `${notRun.length} scenario(s) not executed or inconclusive: ${notRun.slice(0, 4).map(item => `${item.title} (${item.reason ?? item.state})`).join('; ')}.` : 'Every planned scenario was executed.');
	const unexplained = scenarios.filter(item => ['blocked', 'not_executed', 'inconclusive', 'unsupported', 'not_applicable'].includes(item.state) && !item.reason);
	check('non_pass_states_explained', unexplained.length === 0, unexplained.length ? `${unexplained.length} non-passing scenario(s) have no reason.` : 'Every non-passing scenario records why.');
	const auth = graph?.auth ?? {};
	const authResolved = !auth.detected || auth.signedIn || Boolean(auth.blockedReason);
	check('authentication_resolved', authResolved, !auth.detected ? 'No authentication was detected.' : auth.signedIn ? `Signed in and verified (${auth.verifiedBy ?? 'session check'}).` : auth.blockedReason ? `Signed-in area blocked: ${auth.blockedReason}` : 'Authentication was detected but neither completed nor explained.');
	const passedWithoutRun = coverageRows.filter(row => row.state === 'passed' && row.support === 'unsupported');
	check('no_unexecuted_pass', passedWithoutRun.length === 0, passedWithoutRun.length ? `${passedWithoutRun.length} unsupported categories marked passed.` : 'No category is marked passed without an executor run.');
	check('all_categories_classified', coverageRows.length > 0 && coverageRows.every(row => row.state), `${coverageRows.length} categories classified.`);
	const withoutEvidence = findings.filter(item => !item.actual || !(item.steps?.length || item.evidence));
	check('findings_have_evidence', withoutEvidence.length === 0, withoutEvidence.length ? `${withoutEvidence.length} finding(s) lack observed result or evidence.` : `${findings.length} finding(s), each with observed result and evidence.`);
	check('triage_ran', triaged, triaged ? 'Candidates were merged, verified and graded.' : 'Triage did not run.');
	check('not_stopped', !stopped, stopped ? 'The owner stopped the run.' : 'The run was not stopped.', 'advisory');

	const failed = checks.filter(item => !item.ok && item.severity === 'required');
	let status = failed.length ? 'partial' : 'complete';
	if (!state.loaded || (!pages && !state.loaded)) status = 'blocked';
	else if (stopped) status = 'partial';
	return { status, checks, failed: failed.map(item => item.id), evaluatedAt: Date.now() };
}
