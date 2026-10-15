// Isolated manual UI fixture: no real accounts, model calls, or persisted runs.
// Run with node scripts/fixtures/preview-ui-server.mjs, then use the printed URL.
import express from 'express';
import { fileURLToPath } from 'node:url';
const app = express();
const id = '00000000-0000-4000-8000-000000000001';
const frame = { mimeType: 'image/svg+xml', base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#edf1fa"/><rect x="64" y="64" width="1152" height="592" rx="24" fill="white"/><text x="110" y="155" font-family="sans-serif" font-size="36" fill="#263a60">Preview layout test fixture</text><text x="110" y="225" font-family="sans-serif" font-size="22" fill="#52647d">Live updates continue while the browser is minimized.</text></svg>').toString('base64'), viewport: { width: 1280, height: 720 }, url: 'https://example.test/', title: 'Preview fixture' };
const session = { id, title: 'Preview controls — UI fixture', targetUrl: frame.url, status: 'running', mode: 'qa', createdAt: Date.now(), updatedAt: Date.now(), messages: [], activities: [], findings: [], todos: [], secretNames: [], frame };
if (process.env.QASE_UI_FIXTURE === 'completed') {
	session.status = 'done';
	session.title = 'Completed-run status light fixture';
	session.report = { verdict: 'pass', summary: 'Isolated UI fixture for completed status indicators.', covered: ['Status light presentation'], notCovered: [], recommendations: [] };
}
if (process.env.QASE_UI_FIXTURE === 'blocked') {
	session.status = 'done';
	session.title = 'Blocked-run review fixture';
	session.report = { verdict: 'blocked', summary: 'Authentication testing needs credentials for the authorized test account.', notCovered: ['Sign-in could not be tested without credentials.'], recommendations: ['Provide test credentials and resume the run.'] };
	session.findings = [{ id: 'fixture-finding', title: 'Example link issue', severity: 'low', url: frame.url, steps: ['Open the example page.'], expected: 'The link should open.', actual: 'The link is unavailable.' }];
}
app.get('/api/auth/me', (_, res) => process.env.QASE_UI_FIXTURE === 'signin'
	? res.status(401).json({ error: 'Authentication required.' })
	: res.json({ id: 'fixture', displayName: 'UI fixture', profile: { onboardingComplete: true } }));
app.post('/api/auth/login', (_, res) => res.status(401).json({ error: 'Email or password is incorrect. Try again.' }));
app.get('/api/config', (_, res) => res.json({ provider: 'custom', model: 'ui-fixture', ready: true, providers: ['custom'] }));
const sessions = [session];
if (process.env.QASE_UI_FIXTURE === 'run-cards') {
 Object.assign(session, { targetUrl: 'https://new.drytis.com/', startedAt: Date.now() - 229000, todoTotal: 13, todoCompleted: 3, environmentSnapshot: { device: 'iMac (24-inch M1)', browser: 'Chrome', browserVersion: '151' } });
 sessions.push(
  { ...session, id: '00000000-0000-4000-8000-000000000002', status: 'done', mode: 'founder', report: { verdict: 'blocked' }, pausedAt: Date.now() - 200000, updatedAt: Date.now() - 360000, completedAt: Date.now() - 200000, durationSeconds: 1715, todoTotal: 8, todoCompleted: 7, findingCount: 2, environmentSnapshot: { device: 'iPad Pro 12.9 (5th Gen)', browser: 'Safari' } },
  { ...session, id: '00000000-0000-4000-8000-000000000003', targetUrl: 'https://studio.drytis.ai/', status: 'done', mode: 'sqa', updatedAt: Date.now() - 3600000, completedAt: Date.now() - 3600000, durationSeconds: 485, todoTotal: 12, todoCompleted: 12, findingCount: 1, environmentSnapshot: { device: 'Desktop', browser: 'Firefox', browserVersion: '145' } }
 );
}
app.get('/api/sessions', (_, res) => res.json(sessions));
app.get('/api/sessions/:id', (_, res) => res.json(session));
app.get('/api/sessions/:id/events', (req, res) => {
	res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
	res.flushHeaders();
	const send = () => {
		for (const payload of [{ type: 'status', status: session.status }, { type: 'frame', frame }]) res.write(`data: ${JSON.stringify({ sessionId: id, ts: Date.now(), ...payload })}\n\n`);
	};
	send();
	const timer = setInterval(send, 500);
	req.on('close', () => clearInterval(timer));
});
app.get('/api/environments', (_, res) => res.json([]));
app.get('/api/memory', (_, res) => res.json([]));
app.get('/api/sessions/:id/feedback', (_, res) => res.json(null));
app.get('/api/pilot-status', (_, res) => res.json({ pilot: false }));
app.get('/api/{*path}', (_, res) => res.json({}));
app.use(express.static(fileURLToPath(new URL('../../public/', import.meta.url))));
const server = app.listen(0, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/#/runs/${id}`));
