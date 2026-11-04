export function jevExecutionModel(evidence) {
  if (evidence?.controller !== 'coverage-decisions-v2') return null;
  const checks = Array.isArray(evidence.checks) ? evidence.checks : [];
  const assertions = checks.flatMap(check => check.assertions ?? []);
  const count = value => Number.isInteger(value) && value >= 0 ? value : undefined;
  const issueReview = (Array.isArray(evidence.issueReview) ? evidence.issueReview : []).filter(item => item && typeof item === 'object').map(item => ({
    ...item, status: ['confirmed', 'excluded'].includes(item.status) ? item.status : 'unresolved'
  }));
  return {
    routes: evidence.routes, scenarios: evidence.scenarios, checks,
    executedScenarios: count(evidence.executedScenarios), observations: count(evidence.observations),
    nativeConstraintAssertions: count(evidence.nativeConstraintAssertions),
    assertions: count(evidence.totalAssertions) ?? assertions.length, failed: count(evidence.failedAssertions) ?? assertions.filter(item => item.outcome === 'fail').length, stopReason: evidence.stopReason,
    omittedCheckRecords: count(evidence.omittedCheckRecords) || 0,
    issueReview, confirmed: new Set(issueReview.filter(item => item.status === 'confirmed').map((item, index) => item.findingId || `observation-${index}`)).size,
    unresolved: issueReview.filter(item => item.status === 'unresolved').length,
    excluded: issueReview.filter(item => item.status === 'excluded').length
  };
}

/** All target evidence is untrusted text, never executable markup. */
export function renderJevExecution(evidence, document) {
  const model = jevExecutionModel(evidence);
  if (!model) return null;
  const root = document.createElement('section'); root.className = 'report-section jev-execution-evidence';
  const title = document.createElement('h3'); title.textContent = 'Executed QA evidence — JEV-only (no Opus reasoning)';
  const summary = document.createElement('p');
  const scenarios = model.executedScenarios === undefined ? `${model.scenarios} scenario records` : `${model.executedScenarios} behavior scenarios`;
  summary.textContent = `${model.routes} routes · ${scenarios} · ${model.assertions} assertions · ${model.failed} failed assertions (not necessarily confirmed findings)`;
  root.append(title, summary);
  if (model.omittedCheckRecords) {
    const note = document.createElement('p'); note.textContent = `${model.omittedCheckRecords} additional check records are retained in the run data but omitted from this bounded report view. Totals above include those records.`;
    root.append(note);
  }
  if (model.observations !== undefined || model.nativeConstraintAssertions !== undefined) {
    const note = document.createElement('p');
    note.textContent = `${model.observations ?? 0} discovery observations and ${model.nativeConstraintAssertions ?? 0} native constraint assertions are recorded separately. Native constraint checks use detached fields; they do not establish working application submission.`;
    root.append(note);
  }
  if (model.issueReview.length) {
    const title = document.createElement('h4'); title.textContent = 'Potential issues and confirmation';
    const summary = document.createElement('p');
    summary.textContent = `${model.confirmed} confirmed findings · ${model.unresolved} unresolved candidates · ${model.excluded} excluded candidates. Unresolved evidence needs investigation; it is not a passing result or a confirmed defect.`;
    root.append(title, summary);
    const order = { unresolved: 0, confirmed: 1, excluded: 2 };
    let excludedGroup;
    for (const issue of [...model.issueReview].sort((a, b) => order[a.status] - order[b.status])) {
      const details = document.createElement('details');
      const label = document.createElement('summary');
      label.textContent = `${issue.status.toUpperCase()} — ${issue.title || 'Observed issue'} · ${issue.url || 'Unknown route'}`;
      details.append(label);
      const rows = [
        ['Decision', issue.reason], ['Expected', issue.expected], ['Observed', issue.actual], ['Evidence', issue.evidence]
      ];
      if (issue.verification) {
        rows.push(['Reproduction', `${issue.verification.confirmed ? 'Confirmed' : 'Not confirmed'}${Number.isFinite(issue.verification.attempts) ? ` across ${issue.verification.attempts} observations` : ''}${issue.verification.reason ? `: ${issue.verification.reason}` : ''}`]);
      }
      if (typeof issue.modelConfidence === 'number' && Number.isFinite(issue.modelConfidence)) rows.push(['JEV support', `${Math.round(issue.modelConfidence * 100)}% (model judgment; reproduction is recorded separately)`]);
      for (const [heading, value] of rows) if (value) {
        const row = document.createElement('p'); row.textContent = `${heading}: ${value}`; details.append(row);
      }
      if (issue.status === 'excluded') {
        if (!excludedGroup) { excludedGroup = document.createElement('details'); const label = document.createElement('summary'); label.textContent = `${model.excluded} excluded policy/environment observations — not confirmed defects`; excludedGroup.append(label); root.append(excludedGroup); }
        excludedGroup.append(details);
      } else root.append(details);
    }
  }
  for (const check of model.checks) {
    const details = document.createElement('details');
    const label = document.createElement('summary');
    label.textContent = `${check.action} · ${check.url} · ${(check.assertions ?? []).length} assertions${check.success === false ? ' · unavailable' : ''}`;
    const list = document.createElement('ul');
    for (const assertion of check.assertions ?? []) {
      const item = document.createElement('li');
      item.textContent = `${assertion.outcome.toUpperCase()} — ${assertion.name}. Expected: ${assertion.expected}. Observed: ${assertion.actual}`;
      list.append(item);
    }
    details.append(label, list);
    for (const trial of [...(check.trials || []), ...(check.interactions || [])]) {
      if (!trial.skipped && !trial.limitation && trial.success !== false) continue;
      const note = document.createElement('p'); note.textContent = `${trial.label || trial.href || trial.selector || 'Interaction'}: ${trial.skipped || trial.error || trial.limitation}`;
      details.append(note);
    }
    if (check.samples?.length) { const note = document.createElement('p'); note.textContent = `${check.samples.length} document scroll observations; ${Math.round(check.remainingScroll || 0)} pixels beyond the final sampled viewport.`; details.append(note); }
    if (check.error || check.limitations) { const note = document.createElement('p'); note.textContent = check.error || check.limitations; details.append(note); }
    root.append(details);
  }
  return root;
}
