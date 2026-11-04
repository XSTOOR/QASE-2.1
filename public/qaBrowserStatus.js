/** Launcher-only presentation; availability and engines come from the host.
 * Never guess an engine from a browser name or claim a missing row is ready.
 */
export function browserExecutionEngine(row) {
  const engine = row?.executionEngine ?? row?.browserSupport?.engine;
  return ['chromium', 'firefox', 'webkit'].includes(engine) ? engine : null;
}

export function focusedBrowserConfiguration(configurations, hybrid = false) {
  const available = configurations.filter(row => row.availability === 'AVAILABLE' && (!hybrid || browserExecutionEngine(row)));
  return available.find(row => row.browserCode === 'chrome' && ['windows', 'macos', 'linux'].includes(row.platform))
    ?? available.find(row => row.browserCode === 'chrome') ?? available[0] ?? null;
}

export function qaBrowserStatus({ fetchState, configurations = [], envIds = [], mode = 'legacy', config }) {
  const result = (state, title, detail, action, actionLabel) => ({ state, title, detail, action, actionLabel });
  if (fetchState === 'loading') return result('loading', 'Finding your browser…', 'Checking the available browsers and devices. Your selected checks are kept.', null);
  if (fetchState === 'error') return result('blocked', 'Browser list could not load', 'Your setup is saved. Retry the browser list to continue.', 'reload', 'Retry browser list');
  const hybrid = mode === 'hybrid';
  if (hybrid && !config?.hybridQa?.available) return result('blocked', 'Hybrid QA is not ready', 'Refresh model status or choose Existing QA. A current model qualification is required.', 'config', 'Refresh model status');
  const recommended = focusedBrowserConfiguration(configurations, hybrid);
  if (hybrid && !envIds.length && !recommended && configurations.some(row => row.availability === 'AVAILABLE')) return result('blocked', 'Browser details need a refresh', 'Available browsers were found, but their execution details need refreshing. Your setup is kept.', 'reload', 'Refresh browser details');
  if (!envIds.length) return recommended
    ? result('blocked', 'Choose a browser for this run', 'Use the recommended browser, or open customization to choose your own.', 'recommended', 'Use recommended browser')
    : result('blocked', 'No supported browser is ready', 'Check your installed browsers or execution provider, then refresh the list. Nothing will run until a browser is available.', 'reload', 'Refresh browser list');
  if (hybrid && envIds.length > 1) return result('blocked', `${envIds.length} browsers selected`, 'Hybrid testing currently runs one browser at a time. Use one recommended browser; your custom coverage is kept for later.', 'recommended', 'Use one recommended browser');
  const selected = envIds.map(id => configurations.find(row => row.envId === id));
  const invalid = selected.find(row => !row || row.availability !== 'AVAILABLE');
  if (selected.some(row => !row || row.availability !== 'AVAILABLE')) return result('blocked', 'The selected browser is no longer available', invalid?.availabilityReason || 'Refresh browser details or choose another available browser.', recommended ? 'recommended' : 'reload', recommended ? 'Use recommended browser' : 'Refresh browser list');
  if (hybrid && !browserExecutionEngine(selected[0])) return result('blocked', 'Browser details need a refresh', 'This browser is listed as available, but its verified execution details are missing. Refresh the list; your setup is kept.', 'reload', 'Refresh browser details');
  if (selected.length > 1) return result('ready', `${selected.length} browser configurations selected`, 'Each selected configuration will run separately through the existing QA matrix.', 'change', 'Change browsers');
  const row = selected[0];
  const title = [row.browser || 'Browser', row.browserVersion].filter(Boolean).join(' ');
  const device = [row.device, [row.os, row.osVersion].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  const execution = ({ browser_emulation: 'Browser emulation, not a physical device.', simulator: 'Browser-engine simulation, not a native device.', emulator: 'Emulated device.', physical_device: 'Physical device.', virtual_machine: 'Virtual machine.' })[row.executionType] || 'Execution follows the selected environment.';
  return result('ready', title, `${device ? `${device}. ` : ''}${execution} Ready for ${hybrid ? 'one hybrid' : 'this'} test run.`, 'change', 'Change browser');
}

export function renderQaBrowserStatus(model, document) {
  const root = document.getElementById('qa-browser-status');
  if (!root) return;
  root.dataset.state = model.state;
  document.getElementById('qa-browser-status-title').textContent = model.title;
  document.getElementById('qa-browser-status-detail').textContent = model.detail;
  document.getElementById('qa-browser-status-badge').textContent = model.state === 'ready' ? 'Ready' : model.state === 'loading' ? 'Checking' : 'Action needed';
  const action = document.getElementById('qa-browser-status-action');
  action.hidden = !model.action; action.disabled = model.state === 'loading';
  action.dataset.action = model.action || ''; action.textContent = model.actionLabel || '';
}
