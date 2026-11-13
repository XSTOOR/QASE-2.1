import { qaEvidenceStatusLabel } from './runPresentation.js';

export const isQaEvidenceRun = session => session?.mode === 'qa' && session.qaExecutionMode === 'hybrid';

const categories = {
  navigation: 'Navigation', broken_links: 'Links', forms: 'Forms', search: 'Search',
  responsive: 'Responsive layout', accessibility: 'Accessibility', media: 'Media',
  content: 'Content', visual_consistency: 'Visual comparison', console_health: 'Browser errors', authentication: 'Sign-in'
};
const dispositions = {
  passed: ['Passed', 'pass'], failed: ['Failed', 'fail'], running: ['In progress', 'active'],
  blocked: ['Blocked', 'gap'], inconclusive: ['Inconclusive', 'gap'], partial: ['Partial', 'gap'],
  absent: ['Absent on sampled pages', 'gap'], planned: ['Planned', 'neutral'],
  not_executed: ['Not tested', 'gap'], interrupted: ['Interrupted', 'gap']
};
const oracles = {
  host_browser_check: 'Browser assertion',
  request_assertion: 'Requested expectation checked in a browser snapshot',
  host_diagnostic: 'Browser diagnostics'
};
const names = {
  'Snapshot title_equals': 'Page title matches the expected title',
  'Snapshot url_equals': 'Page URL matches the expected destination',
  'Snapshot text_contains': 'Rendered text contains the expected copy'
};

function disposition(scenario, status) {
  if (scenario.failed) return 'failed';
  if (scenario.absent) return 'absent';
  if (scenario.status === 'passed') {
    if (!scenario.passed) return 'inconclusive';
    return scenario.incompleteRoutes || scenario.gaps.length ? 'partial' : 'passed';
  }
  if (scenario.status === 'failed') return 'inconclusive';
  if (scenario.status === 'running' && ['done', 'error', 'interrupted', 'cancelled'].includes(status)) return 'interrupted';
  if (scenario.status === 'planned' && ['done', 'error', 'interrupted', 'cancelled'].includes(status)) return 'not_executed';
  return Object.hasOwn(dispositions, scenario.status) ? scenario.status : 'not_executed';
}

function browserLabel(session) {
  const env = session.environmentSnapshot;
  const facts = session.runtimeFacts;
  const selected = [env?.browser, env?.browserVersion].filter(Boolean).join(' ');
  const engine = facts?.launchedEngineId || facts?.executionEngine || env?.executionEngine || session.engine;
  const engineLabel = ({ chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' })[engine] || engine;
  const binary = facts?.brandedBinary;
  const binaryLabel = binary?.brand && binary.fallbackUsed === false
    ? [env?.browser || binary.brand, binary.detectedVersion].filter(Boolean).join(' ')
    : engineLabel;
  const level = facts?.executionLevel || session.executionLevel;
  const device = env?.device || env?.deviceLabel;
  const deviceMode = ({
    SIMULATED: 'Browser emulation', VIRTUAL_DEVICE: 'Virtual device', REAL_DEVICE: 'Physical device'
  })[level] || ({
    browser_emulation: 'Browser emulation', simulator: 'Browser-engine simulation', emulator: 'Emulated device',
    physical_device: 'Configured physical device', virtual_machine: 'Configured virtual machine'
  })[env?.executionType];
  const viewport = session.hybrid?.viewport?.primary ?? facts?.viewport;
  const profile = device && selected ? `${device} · ${selected} profile` : device || selected || 'Browser configuration unavailable';
  return [
    profile,
    [deviceMode, binaryLabel,
      viewport?.width && viewport?.height ? `${viewport.width} × ${viewport.height}` : null].filter(Boolean).join(' · ')
  ];
}

function present(root, session, evidence, { live, error, retry, onFinding, onFindings, onActivity }) {
  const doc = root.ownerDocument;
  const create = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const button = (text, action, key) => {
    const node = create('button', 'qe-link', text);
    node.type = 'button';
    node.dataset.qeKey = key;
    node.onclick = action;
    return node;
  };
  const summary = (label, key) => {
    const node = create('details', 'qe-details');
    node.dataset.qeKey = key;
    node.append(create('summary', '', label));
    return node;
  };
  const badge = (label, tone) => {
    const node = create('span', 'qe-badge', label);
    node.dataset.tone = tone;
    return node;
  };
  const list = items => {
    const node = create('ul', 'qe-list');
    for (const item of items) node.append(create('li', '', item));
    return node;
  };
  const scenarios = (evidence?.scenarios || []).map(scenario => ({ ...scenario, disposition: disposition(scenario, session.status) }));
  if (!live) scenarios.sort((a, b) => Number(b.failed > 0) - Number(a.failed > 0));
  const gaps = scenarios.filter(scenario => !['passed', 'failed', 'running', 'planned'].includes(scenario.disposition)
    || scenario.incompleteRoutes > 0 || scenario.gaps.length > 0);
  const count = field => scenarios.reduce((total, scenario) => total + scenario[field], 0);
  const confirmed = session.findings?.filter(finding => finding.hybridEvidence).length || 0;
  const active = scenarios.find(scenario => scenario.id === evidence?.currentScenarioId);
  const [browser, device] = browserLabel(session);
  const status = qaEvidenceStatusLabel(session);
  const discovery = evidence?.discovery;
  const title = live ? 'Test progress' : 'Browser results';
  const reportGaps = session.report?.notCovered || session.hybrid?.gaps || [];
  const limits = [...new Set([...reportGaps, ...(discovery?.limitations || [])])].filter(Boolean);
  const workspace = create('section', 'qe-workspace');
  workspace.setAttribute('aria-label', title);

  const hero = create('header', 'qe-hero');
  const heroHead = create('div', 'qe-hero-heading');
  heroHead.append(create('h2', '', title));
  const statusTone = status.startsWith('Failed') ? 'fail'
    : ['interrupted', 'awaiting_input', 'error'].includes(session.status) || /gaps|blocked/i.test(status) ? 'gap'
    : session.status === 'running' ? 'active' : 'neutral';
  heroHead.append(badge(status, statusTone));
  hero.append(heroHead);
  if (live && session.status === 'running') {
    hero.append(create('p', '', active ? active.objective || categories[active.category] || active.category
      : discovery?.status === 'ready' ? 'Preparing checks from observed pages and controls.'
      : discovery?.status === 'blocked' ? 'Discovery is blocked. Review the recorded limits below.'
      : 'Looking for pages and controls to test.'));
  } else if (session.statusDetail || session.hybrid?.pauseReason) {
    hero.append(create('p', '', session.hybrid?.pauseReason || session.statusDetail));
  }
  const environment = create('div', 'qe-browser');
  const icon = create('span', 'qe-browser-icon');
  icon.setAttribute('aria-hidden', 'true');
  const environmentText = create('div');
  environmentText.append(create('strong', '', browser));
  if (device) environmentText.append(create('p', '', device));
  environment.append(icon, environmentText);
  hero.append(environment);

  if (evidence) {
    const metrics = create('dl', 'qe-metrics');
    for (const [label, value, tone] of [
      ['Assertions passed', count('passed'), 'pass'],
      ['Assertions failed', count('failed'), 'fail'],
      ['Scenarios with gaps', gaps.length, 'gap'],
      ['Confirmed findings', confirmed, 'neutral']
    ]) {
      const metric = create('div');
      metric.dataset.tone = tone;
      metric.append(create('dt', '', label), create('dd', '', String(value)));
      metrics.append(metric);
    }
    hero.append(metrics);
  }
  workspace.append(hero);
  if (!evidence || error) {
    const notice = create('div', 'qe-notice');
    notice.append(create('p', '', error
      ? evidence ? 'Could not refresh the evidence. Showing the last saved view.' : 'Could not load the saved browser evidence.'
      : 'Loading browser evidence…'));
    if (error) notice.append(button('Retry evidence', retry, 'retry'));
    else notice.setAttribute('role', 'status');
    workspace.append(notice);
  }
  if (!evidence) { restoreReader(workspace); return; }

  const grid = create('div', 'qe-grid');
  const main = create('section', 'qe-main');
  const mainHead = create('div', 'qe-section-head');
  mainHead.append(create('h3', '', live ? 'Scenario plan' : 'Scenario results'));
  if (confirmed) mainHead.append(button('View findings', onFindings, 'findings'));
  main.append(mainHead);
  if (!scenarios.length) main.append(create('p', 'qe-empty', 'No scenarios have been recorded.'));

  function renderAssertion(assertion) {
    const entry = create('li', 'qe-assertion');
    entry.dataset.outcome = assertion.outcome;
    const head = create('div', 'qe-assertion-head');
    head.append(create('h5', '', names[assertion.name] || assertion.name), badge(assertion.outcome === 'fail' ? 'Fail' : 'Pass', assertion.outcome));
    entry.append(head);
    if (assertion.source || assertion.destination || assertion.control) {
      entry.append(create('p', 'qe-path', [assertion.source, assertion.control, assertion.destination].filter(Boolean).join(' → ')));
    }
    const comparison = create('dl', 'qe-compare');
    for (const [label, value] of [['Expected', assertion.expected], ['Observed', assertion.actual]]) {
      const cell = create('div');
      cell.append(create('dt', '', label), create('dd', '', value ?? 'Value unavailable'));
      comparison.append(cell);
    }
    entry.append(comparison);
    const receipt = summary('Evidence receipt', `receipt-${assertion.id}`);
    const provenance = [
      oracles[assertion.authority],
      assertion.httpStatus ? `HTTP ${assertion.httpStatus}` : null,
      assertion.capturedAt ? new Date(assertion.capturedAt).toLocaleString() : null
    ].filter(Boolean).join(' · ');
    receipt.append(create('p', '', provenance), create('code', '', assertion.reference));
    if (assertion.findingId) receipt.append(button('Open confirmed finding', () => onFinding(assertion.findingId), `finding-${assertion.id}`));
    entry.append(receipt);
    return entry;
  }

  for (const scenario of scenarios) {
    const row = create('article', 'qe-scenario');
    const [label, tone] = dispositions[scenario.disposition];
    row.dataset.tone = tone;
    const head = create('div', 'qe-scenario-head');
    head.append(create('h4', '', categories[scenario.category] || scenario.category.replaceAll('_', ' ')), badge(label, tone));
    row.append(head);
    if (scenario.objective && !scenario.objective.startsWith(`${scenario.category}: `)
      && scenario.objective !== `Exercise selected ${scenario.category} scope`) row.append(create('p', '', scenario.objective));
    if (scenario.targets.length) row.append(create('p', 'qe-scenario-targets', `Observed controls or pages · ${scenario.targets.join(', ')}`));
    else if (scenario.route) row.append(create('p', 'qe-path', scenario.route));
    if (scenario.expectation && !scenario.assertions.length) row.append(create('p', 'qe-scenario-targets', `Requested result · ${scenario.expectation}`));
    if (scenario.gaps.length) row.append(list(scenario.gaps));
    else if (scenario.absent) row.append(create('p', '', 'The browser did not find an eligible control on the sampled pages.'));
    if (scenario.incompleteRoutes) row.append(create('p', 'qe-scenario-targets', `${scenario.incompleteRoutes} page or feature trials without a conclusive result.`));
    if (scenario.assertions.length) {
      const evidenceRows = create('ol', 'qe-assertions');
      const [first, ...rest] = [...scenario.assertions].sort((a, b) => Number(b.outcome === 'fail') - Number(a.outcome === 'fail'));
      evidenceRows.append(renderAssertion(first));
      row.append(evidenceRows);
      if (rest.length) {
        const remaining = summary(`${rest.length} more ${rest.length === 1 ? 'assertion' : 'assertions'}`, `assertions-${scenario.id}`);
      const more = create('ol', 'qe-assertions');
        for (const assertion of rest) more.append(renderAssertion(assertion));
        remaining.append(more);
        row.append(remaining);
      }
      if (scenario.passed + scenario.failed > scenario.assertions.length) {
        row.append(create('p', 'qe-scenario-targets', `Showing ${scenario.assertions.length} of ${scenario.passed + scenario.failed} recorded assertions.`));
      }
    }
    main.append(row);
  }

  const sidebar = create('aside', 'qe-sidebar');
  const discovered = create('section', 'qe-card');
  discovered.append(create('h3', '', 'What Qase discovered'));
  if (discovery?.features.length) {
    discovered.append(create('p', '', `${discovery.total} pages, controls and feature states observed.`));
    const features = create('ul', 'qe-inventory');
    for (const feature of discovery.features.slice(0, 6)) {
      const item = create('li');
      const kind = ({ surface: 'Page', link: 'Link', navigation: 'Navigation', form_opener: 'Form opener' })[feature.kind] || feature.kind.replaceAll('_', ' ');
      item.append(create('strong', '', feature.name), create('span', '', [kind, feature.location].filter(Boolean).join(' · ')));
      features.append(item);
    }
    discovered.append(features);
    if (discovery.features.length > 6) {
      const rest = summary(`${discovery.features.length - 6} more observed`, 'discovery');
      rest.append(list(discovery.features.slice(6).map(feature => feature.name)));
      discovered.append(rest);
    }
    if (discovery.total > discovery.features.length) discovered.append(create('p', '', `Showing ${discovery.features.length} of ${discovery.total} observations.`));
  } else discovered.append(create('p', '', discovery?.status === 'blocked' ? 'The browser could not complete discovery.'
    : discovery?.status === 'pending' ? 'The browser has yet to record an eligible page or control.' : 'No discovery inventory is available for this run.'));
  sidebar.append(discovered);

  const coverage = create('section', 'qe-card');
  const capabilities = ['Coverage is limited to the selected browser and device configuration.'];
  capabilities.push(scenarios.some(scenario => scenario.category === 'visual_consistency' && scenario.passed + scenario.failed > 0)
    ? 'Animation timing and theme flashes require dedicated checks.'
    : 'Animation timing, visual regressions and theme flashes have no recorded checks here.');
  coverage.append(create('h3', '', 'Coverage limits'), list(capabilities));
  if (limits.length) {
    const details = summary('Recorded coverage gaps', 'coverage');
    details.append(list(limits));
    coverage.append(details);
  }
  if (live) coverage.append(button('Open activity log', onActivity, 'activity'));
  sidebar.append(coverage);
  grid.append(main, sidebar);
  workspace.append(grid);

  restoreReader(workspace);

  function restoreReader(next) {
    const open = new Set([...root.querySelectorAll('details[open][data-qe-key]')].map(node => node.dataset.qeKey));
    const focused = root.contains(doc.activeElement) ? doc.activeElement.closest('[data-qe-key]')?.dataset.qeKey : undefined;
    const pane = root.closest('.tab-pane');
    const top = pane?.scrollTop;
    for (const node of next.querySelectorAll('details[data-qe-key]')) node.open = open.has(node.dataset.qeKey);
    root.replaceChildren(next);
    if (top && pane) pane.scrollTop = top;
    if (focused) {
      const node = [...root.querySelectorAll('[data-qe-key]')].find(item => item.dataset.qeKey === focused);
      (node?.matches('details') ? node.querySelector('summary') : node)?.focus({ preventScroll: true });
    }
  }
}

/** Read saved evidence independently of the high-frequency execution stream.
 * Checkpoints coalesce into one fetch, and old responses cannot repaint a new run. */
export function createQaEvidenceWorkspace({ api, plan, report, ...actions }) {
  let session, evidence, error, timer, inFlight, pending, signature;

  function render() {
    if (!session) return;
    const snapshot = JSON.stringify([session.id, session.status, session.statusDetail, session.report?.verdict,
      session.report?.notCovered, session.hybrid?.pauseReason, session.hybrid?.gaps, session.hybrid?.viewport?.primary,
      session.runtimeFacts, session.executionLevel, session.environmentSnapshot, session.engine, session.findings?.length, evidence, error]);
    if (snapshot === signature) return;
    signature = snapshot;
    const options = { ...actions, error, retry: () => schedule(0) };
    present(plan, session, evidence, { ...options, live: true });
    present(report, session, evidence, { ...options, live: false });
  }

  function schedule(delay = 1000) {
    if (!session) return;
    pending = true;
    if (timer || inFlight) return;
    timer = setTimeout(async () => {
      timer = undefined;
      const id = session?.id;
      if (!id) return;
      pending = false;
      const request = api(`/sessions/${encodeURIComponent(id)}/qa-evidence`);
      inFlight = request;
      try {
        const result = await request;
        if (inFlight === request) { evidence = result; error = false; }
      } catch {
        if (inFlight === request) error = true;
      } finally {
        if (inFlight === request) {
          inFlight = undefined;
          render();
          if (pending) schedule();
        }
      }
    }, delay);
  }

  return function update(next, refresh = false) {
    const hybrid = isQaEvidenceRun(next) ? next : undefined;
    const changed = session?.id !== hybrid?.id;
    if (changed) {
      clearTimeout(timer);
      timer = inFlight = evidence = signature = undefined;
      error = pending = false;
      plan.replaceChildren();
      report.replaceChildren();
    }
    session = hybrid;
    plan.hidden = report.hidden = !hybrid;
    render();
    if (changed || refresh) schedule(changed ? 0 : undefined);
  };
}
