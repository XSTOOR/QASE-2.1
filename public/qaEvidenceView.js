import { runPresentationLabel, qaScenarioDisposition } from './runPresentation.js';

export const isQaEvidenceRun = session => session?.mode === 'qa' && session.qaExecutionMode === 'hybrid';

const categories = {
  navigation: 'Navigation', broken_links: 'Links', forms: 'Forms', search: 'Search',
  responsive: 'Responsive layout', accessibility: 'Accessibility', media: 'Media',
  content: 'Content', visual_consistency: 'Visual comparison', menu_motion: 'Menu transition', console_health: 'Browser errors', authentication: 'Sign-in'
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
  'Snapshot heading_equals': 'Visible heading matches the request',
  'Snapshot title_equals': 'Page title matches the expected title',
  'Snapshot url_equals': 'Page URL matches the expected destination',
  'Snapshot text_contains': 'Rendered text contains the expected copy'
};

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

function present(root, session, evidence, { live, view, preview, redraw, error, retry, onFinding, onFindings, onActivity }) {
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
  const scenarios = (evidence?.scenarios || []).map(scenario => ({ ...scenario, disposition: qaScenarioDisposition(scenario, session.status) }));
  if (!live) scenarios.sort((a, b) => Number(b.failed > 0) - Number(a.failed > 0));
  const gaps = scenarios.filter(scenario => !['passed', 'failed', 'running', 'planned'].includes(scenario.disposition)
    || scenario.incompleteRoutes > 0 || scenario.gaps.length > 0);
  const count = field => scenarios.reduce((total, scenario) => total + scenario[field], 0);
  const confirmed = evidence?.confirmedFindings;
  const unverified = evidence?.unverifiedFindings;
  const active = scenarios.find(scenario => scenario.id === evidence?.currentScenarioId);
  const selected = scenarios.find(scenario => scenario.id === view?.scenarioId) ?? active ?? scenarios[0];
  const [browser, device] = browserLabel(session);
  const status = runPresentationLabel(session);
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
      ['Confirmed findings', confirmed ?? '—', 'neutral']
    ]) {
      const metric = create('div');
      metric.dataset.tone = tone;
      metric.append(create('dt', '', label), create('dd', '', String(value)));
      metrics.append(metric);
    }
    hero.append(metrics);
    if (unverified > 0) {
      hero.append(create('p', '', unverified === 1
        ? '1 saved finding lacks verifiable evidence.'
        : `${unverified} saved findings lack verifiable evidence.`));
    }
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
  // Keep the browser visible while the independently loaded evidence is pending.
  if (!evidence && live) {
    workspace.append(preview);
    restoreReader(workspace);
    return;
  }
  if (!evidence) { restoreReader(workspace); return; }

  const grid = create('div', live ? 'qe-live-grid' : 'qe-grid');
  const main = create('section', 'qe-main');
  const mainHead = create('div', 'qe-section-head');
  mainHead.append(create('h3', '', live ? 'Selected check' : 'Scenario results'));
  if (confirmed > 0 || unverified > 0) mainHead.append(button('View findings', onFindings, 'findings'));
  main.append(mainHead);
  if (!scenarios.length) main.append(create('p', 'qe-empty', 'No scenarios have been recorded.'));

  if (live) {
    const switcher = create('div', 'qe-live-switcher');
    switcher.setAttribute('role', 'group');
    switcher.setAttribute('aria-label', 'Test progress views');
    const journey = create('section', 'qe-card qe-journey');
    journey.append(create('h3', '', 'Journey'));
    const rows = create('ol', 'qe-journey-steps');
    for (const scenario of scenarios) {
      const row = create('li');
      const select = button('', () => {
        view.scenarioId = scenario.id;
        if (switcher.getClientRects().length) {
          view.panel = 'step';
          redraw();
          root.querySelector('[data-qe-key="panel-step"]')?.focus();
        } else redraw();
      }, `step-${scenario.id}`);
      select.className = 'qe-journey-step';
      select.setAttribute('aria-pressed', String(scenario.id === selected?.id));
      if (session.status === 'running' && scenario.id === active?.id) select.setAttribute('aria-current', 'step');
      const [label, tone] = dispositions[scenario.disposition];
      select.append(create('strong', '', categories[scenario.category] || scenario.category), badge(label, tone));
      row.append(select);
      rows.append(row);
    }
    journey.append(rows);
    if (!scenarios.length) journey.append(create('p', '', 'Checks appear as Qase plans the journey.'));
    for (const [key, label, panel] of [['journey', 'Journey', journey], ['preview', 'Preview', preview], ['step', 'Step', main]]) {
      panel.dataset.qePanel = key;
      const toggle = button(label, () => { view.panel = key; redraw(); }, `panel-${key}`);
      toggle.setAttribute('aria-pressed', String(key === view.panel));
      switcher.append(toggle);
    }
    grid.dataset.panel = view.panel;
    grid.append(journey, preview, main);
    workspace.append(switcher);
  }

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

  function renderMotion(motion, scenarioId) {
    const details = summary('Timing and screenshots', `motion-${scenarioId}`);
    const preference = motion.preference === 'reduce' ? 'Reduced motion enabled' : 'Standard motion';
    details.append(create('p', '', `${preference} · ${motion.deadlineMs} ms deadline`));
    if (motion.visual) details.append(create('p', '', `Visual comparison · ${motion.visual.outcome} · ${motion.visual.reason}`));
    for (const [index, trial] of motion.trials.entries()) {
      const elapsed = trial.visibleAtMs === null ? 'No stable visible state' : `Visible at ${trial.visibleAtMs} ms`;
      const samples = summary(`Opening ${index + 1} · ${elapsed} · final opacity ${trial.finalOpacity}`, `motion-trial-${scenarioId}-${index}`);
      samples.append(list(trial.frames.map(frame => `${frame.elapsedMs} ms · opacity ${frame.opacity}${frame.visible ? ' · visible' : ''}${frame.transitioning ? ' · transitioning' : ''}`)));
      details.append(samples);
    }
    if (!motion.screenshots.length) details.append(create('p', '', 'No screenshots were saved for this check.'));
    else {
      const frames = create('ul', 'qe-list');
      for (const frame of motion.screenshots) {
        const item = create('li');
        const link = create('a', '', `Open screenshot · ${frame.phase}`);
        link.href = `/api/sessions/${encodeURIComponent(session.id)}/artifacts/${encodeURIComponent(frame.artifactId)}`;
        link.target = '_blank';
        link.rel = 'noopener';
        item.append(link);
        if (frame.capturedAt) item.append(` · ${new Date(frame.capturedAt).toLocaleString()}`);
        frames.append(item);
      }
      details.append(frames);
    }
    return details;
  }

  for (const scenario of live ? (selected ? [selected] : []) : scenarios) {
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
    if (scenario.motion) row.append(renderMotion(scenario.motion, scenario.id));
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
  capabilities.push(scenarios.some(scenario => scenario.category === 'menu_motion' && scenario.motion)
    ? 'Motion coverage is limited to the named menu, browser and motion preference shown in the result.'
    : scenarios.some(scenario => scenario.category === 'visual_consistency' && scenario.passed + scenario.failed > 0)
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
  if (!live) grid.append(main, sidebar);
  workspace.append(grid);
  if (live) workspace.append(sidebar);

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
  let view, preview, frame, saved, artifactRequest, artifactStatus, imageFailed, connection;

  function createPreview() {
    const doc = plan.ownerDocument;
    const panel = doc.createElement('section');
    panel.className = 'qe-card qe-preview';
    const heading = doc.createElement('h3');
    heading.textContent = 'Browser preview';
    const description = doc.createElement('p');
    description.setAttribute('role', 'status');
    description.tabIndex = -1;
    const retry = doc.createElement('button');
    retry.className = 'qe-link';
    retry.type = 'button';
    retry.textContent = 'Retry screenshot';
    retry.hidden = true;
    retry.addEventListener('click', () => {
      description.focus();
      if (imageFailed) {
        imageFailed = undefined;
        image.removeAttribute('src');
      }
      loadSavedPreview();
    });
    const image = doc.createElement('img');
    image.hidden = true;
    image.addEventListener('error', () => {
      if (preview?.image !== image) return;
      imageFailed = image.getAttribute('src');
      renderPreview();
    });
    panel.append(heading, description, retry, image);
    return { panel, description, retry, image };
  }

  function renderPreview() {
    if (!session || !preview) return;
    const { description, retry, image } = preview;
    const active = session.status === 'running';
    const showSaved = !active && saved;
    const src = showSaved ? `/api/sessions/${encodeURIComponent(session.id)}/artifacts/${encodeURIComponent(saved.artifactId)}`
      : frame ? `data:${frame.mimeType};base64,${frame.base64}` : null;
    const label = showSaved ? 'Saved browser screenshot'
      : active && connection === 'live' ? 'Live browser preview' : 'Last received browser frame';
    const time = showSaved ? saved.capturedAt : frame?.ts;
    const validTime = time && Number.isFinite(new Date(time).getTime());
    const readFailed = !active && artifactStatus === 'failed';
    const failedImage = Boolean(src && imageFailed === src);
    const message = readFailed ? 'Could not retrieve the saved browser screenshot.'
      : failedImage ? 'This browser image could not be loaded.'
      : src ? `${label} · ${validTime ? new Date(time).toLocaleString() : 'Capture time unavailable'}`
      : !active && artifactStatus === 'loading' ? 'Looking for a saved browser screenshot…'
      : active ? 'The preview appears when Qase captures a browser frame.' : 'No saved browser screenshot is available for this run.';
    if (description.textContent !== message) description.textContent = message;
    retry.hidden = active || artifactStatus === 'loading' || !(readFailed || (showSaved && failedImage));
    image.alt = label;
    if (src !== image.getAttribute('src')) {
      imageFailed = undefined;
      if (src) image.src = src;
      else image.removeAttribute('src');
    }
    image.hidden = !src || failedImage || readFailed && showSaved;
  }

  function loadSavedPreview() {
    if (!session || !['done', 'error', 'paused', 'interrupted', 'cancelled'].includes(session.status) || artifactRequest) return;
    const request = api(`/sessions/${encodeURIComponent(session.id)}/artifacts`);
    artifactRequest = request;
    artifactStatus = 'loading';
    renderPreview();
    void request.then(result => {
      if (artifactRequest !== request) return;
      if (!Array.isArray(result.artifacts)) throw new Error('Invalid artifact list.');
      saved = result.artifacts?.find(item => item.type === 'screenshot' && item.artifactId);
      artifactStatus = 'settled';
    }).catch(() => {
      if (artifactRequest === request) artifactStatus = 'failed';
    }).finally(() => {
      if (artifactRequest !== request) return;
      artifactRequest = undefined;
      renderPreview();
    });
  }

  function render() {
    if (!session) return;
    const snapshot = JSON.stringify([session.id, session.status, session.statusDetail, session.report?.verdict, view,
      session.report?.notCovered, session.hybrid?.pauseReason, session.hybrid?.gaps, session.hybrid?.viewport?.primary,
      session.runtimeFacts, session.executionLevel, session.environmentSnapshot, session.engine, evidence, error]);
    if (snapshot === signature) return;
    signature = snapshot;
    const options = { ...actions, error, retry: () => schedule(0) };
    present(plan, session, evidence, { ...options, live: true, view, preview: preview.panel, redraw: render });
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

  function update(next, refresh = false) {
    const hybrid = isQaEvidenceRun(next) ? next : undefined;
    const changed = session?.id !== hybrid?.id;
    const statusChanged = session?.status !== hybrid?.status;
    if (changed) {
      clearTimeout(timer);
      timer = inFlight = evidence = signature = undefined;
      frame = saved = artifactRequest = artifactStatus = imageFailed = connection = undefined;
      view = { panel: 'journey' };
      preview = hybrid ? createPreview() : undefined;
      error = pending = false;
      plan.replaceChildren();
      report.replaceChildren();
    }
    session = hybrid;
    plan.hidden = report.hidden = !hybrid;
    render();
    renderPreview();
    if (changed || statusChanged || (refresh && artifactStatus !== 'failed')) loadSavedPreview();
    if (changed || refresh) schedule(changed ? 0 : undefined);
  }

  function updatePreview(id, { nextFrame, streamConnection } = {}) {
    if (session?.id !== id) return;
    connection = streamConnection;
    if (nextFrame?.base64 && /^image\/(?:png|jpeg|webp)$/.test(nextFrame.mimeType)
      && !(nextFrame.ts && frame?.ts && nextFrame.ts < frame.ts)) frame = nextFrame;
    renderPreview();
  }

  return { update, updatePreview };
}
