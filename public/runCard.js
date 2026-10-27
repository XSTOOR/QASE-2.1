// Presentation only: never infer an unrecorded browser or runtime.
const clean = value => typeof value === 'string' && !['undefined', 'null'].includes(value.trim()) ? value.trim() : '';

export function runCardDetails(run, profiles = []) {
 const snapshot = run.environmentSnapshot ?? {};
 const profile = profiles.find(item => item.id === run.device);
 const device = clean(snapshot.device) || clean(profile?.label) || (run.device === 'desktop' ? 'Desktop' : clean(run.device));
 const browser = clean(snapshot.browser) || ({ chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' }[run.engine] ?? clean(run.engine));
 const environment = [device, browser ? [browser, clean(snapshot.browserVersion)].filter(Boolean).join(' ') : ''].filter(Boolean).join(' · ');
 const hybrid = run.qaExecutionMode === 'hybrid' && Number.isFinite(run.scenarioTotal);
 const rawTotal = hybrid ? run.scenarioTotal : run.todoTotal, rawCompleted = hybrid ? run.scenarioExecuted : run.todoCompleted;
 const total = Number.isFinite(rawTotal) ? Math.max(0, Math.floor(rawTotal)) : 0;
 const completed = Math.min(total, Math.max(0, Number.isFinite(rawCompleted) ? Math.floor(rawCompleted) : 0));
 return {
  environment: environment + (environment && run.deviceLandscape ? ' · Landscape' : ''),
  mode: run.mode === 'founder' ? 'Founder' : run.mode === 'sqa' ? 'Quality' : 'Test',
  findings: Number.isFinite(run.findingCount) ? Math.max(0, Math.floor(run.findingCount)) : 0,
  total, completed, percent: total ? Math.round(completed / total * 100) : 0
 };
}
