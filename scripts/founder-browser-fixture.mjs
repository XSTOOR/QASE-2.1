import { randomUUID } from 'node:crypto';
import { createFounderReportFixture } from '../server/founderReportFixture.js';
import { createFounderState, createFounderReviewTodos, recordFounderObservations, recordFounderPublicOnlyDecision, finishFounderReview, FOUNDER_CATEGORY_IDS } from '../server/founderService.js';

export async function createFounderBrowserFixture() {
  const now = Date.now(), id = randomUUID();
  const activities = ['browser_open', 'browser_snapshot', 'browser_diagnostics'].map((toolName, i) => ({ id: `reader-activity-${i}`, toolName, status: 'done', ts: now, detail: 'Synthetic browser-reader acceptance fixture.', summary: 'Synthetic receipt for report-reader tests; no live product conclusion.' }));
  const session = { id, mode: 'founder', status: 'running', title: 'Report reader fixture', targetUrl: 'https://fixture.test/', createdAt: now, updatedAt: now, messages: [], findings: [], secretNames: [], activities, todos: createFounderReviewTodos().map(todo => ({ ...todo, status: 'completed' })),
    founder: createFounderState({ authorizationConfirmed: true, target: { name: 'Report reader fixture', url: 'https://fixture.test/' }, productContext: { stage: 'Test', targetCustomer: 'Test teams', businessModel: 'Hypothesis', primaryGoal: 'Exercise report reading' } }) };
  recordFounderPublicOnlyDecision(session);
  const store = { async commit() {} };
  await recordFounderObservations(session, FOUNDER_CATEGORY_IDS.map(category => ({ category, type: 'opportunity', title: `Recorded ${category}`, summary: 'Synthetic product observation for interface acceptance, not live qualification.', confidence: 'low', evidence_activity_ids: activities.map(activity => activity.id) })), store);
  const { payload } = createFounderReportFixture();
  const bind = value => {
    if (Array.isArray(value)) return value.map(bind);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'evidence_observation_ids' && item.length ? [session.founder.observations[0].id] : bind(item)]));
    return value;
  };
  const report = bind(payload);
  report.recommendations.forEach(item => { item.assumptions = ['The proposed improvement still requires a usability test with target teams.']; });
  await finishFounderReview(session, report, store);
  session.status = 'done';
  return session;
}
