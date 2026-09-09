import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runTurn } from '../server/agent.js';
import { getConfig } from '../server/config.js';
import { createSqaState, createSqaTodoPlan } from '../server/sqaService.js';
import { buildSqaReportMarkdown } from '../server/sqaAssessment.js';
import { createFounderState, createFounderReviewTodos, buildFounderReportMarkdown } from '../server/founderService.js';
import { buildReportMarkdown } from '../server/report.js';
import { startMediaFixture } from './fixtures/media-site.mjs';

// Opt-in: uses the operator's configured model gateway. Only fixture content
// leaves the host. Sessions stay isolated from the user's saved run history.
const mode = process.argv[2] ?? 'qa';
if (!['qa', 'sqa', 'founder'].includes(mode)) throw new Error('Usage: node scripts/qualify-agent.mjs qa|sqa|founder');
const focused = process.argv.includes('--media-only');
if (focused && mode !== 'qa') throw new Error('--media-only is a QA follow-up qualification.');
const resumeIndex = process.argv.indexOf('--resume');
const sourceSession = resumeIndex < 0 ? undefined : path.resolve(process.argv[resumeIndex + 1] ?? '');
if (sourceSession && !['founder', 'sqa'].includes(mode)) throw new Error('--resume supports Founder and SQA qualification recovery.');
const resumedSession = sourceSession ? JSON.parse(fs.readFileSync(sourceSession, 'utf8')) : undefined;
if (resumedSession && (resumedSession.mode !== mode || resumedSession[mode]?.finalizedAt || !resumedSession.activities?.some(activity => activity.toolName === 'browser_snapshot' && activity.status === 'done'))) throw new Error('Recovery requires an unfinished qualification of the selected mode with durable browser evidence.');
let fixturePort = 0;
if (resumedSession && mode === 'sqa') {
	const originalTarget = new URL(resumedSession.targetUrl);
	if (originalTarget.protocol !== 'http:' || originalTarget.hostname !== '127.0.0.1' || !originalTarget.port || resumedSession.title !== 'sqa controlled media qualification') throw new Error('SQA recovery only accepts this script\'s controlled localhost fixture sessions.');
	fixturePort = Number(originalTarget.port);
}
const outputDir = path.resolve('test-results', `agent-${mode}-${sourceSession ? 'recovered-' : focused ? 'media-' : ''}${Date.now()}`);
fs.mkdirSync(outputDir, { recursive: true });
const fixture = sourceSession && mode === 'founder' ? undefined : await startMediaFixture({ port: fixturePort });
const session = resumedSession ?? {
	id: randomUUID(), mode, title: `${mode} controlled media qualification`, targetUrl: fixture.url, createdAt: Date.now(),
	device: 'desktop', deviceLandscape: false, messages: [], activities: [], findings: [], todos: [], secretNames: [], status: 'idle'
};
session.createdAt ??= session.messages?.[0]?.ts ?? Date.now();
if (mode === 'sqa' && !resumedSession) {
	session.sqa = createSqaState({ authorizationConfirmed: true, profiles: ['core'], attributes: ['web_application', 'user_interface'], target: { name: 'Team practice studio', release: 'fixture-1', environment: 'local qualification', url: fixture.url }, scopeNotes: 'Public-only isolated local fixture. No login, account, external calls, real attendees, standards documents, or reviewer artifacts. Test browser technical controls including microphone and meeting links; other assurance requirements remain blocked when evidence is absent.' });
	session.todos = createSqaTodoPlan(session.sqa);
}
if (mode === 'founder' && !resumedSession) {
	session.founder = createFounderState({ authorizationConfirmed: true, target: { name: 'Team practice studio', url: fixture.url }, productContext: { stage: 'MVP test fixture', businessModel: 'B2B subscription hypothesis', targetCustomer: 'Small remote teams', primaryGoal: 'Validate activation through local microphone practice', constraints: 'Public-only isolated fixture, no users or revenue supplied, no external research.' } });
	session.todos = createFounderReviewTodos();
}
const live = {};
const store = {
	liveFor: () => live, listLive: () => [{ id: session.id, record: live }],
	publish() {},
	async commit() { save(); },
	async setStatus(s, status, detail) { s.status = status; if (detail) s.statusDetail = detail; console.log(`[${mode}] ${status}${detail ? `: ${detail}` : ''}`); save(); },
	async addActivity(s, item) { const next = { id: randomUUID(), ts: Date.now(), ...item }; s.activities.push(next); console.log(`[${mode}] ${next.toolName}`); return next; },
	async updateActivity(s, id, patch) { Object.assign(s.activities.find(item => item.id === id) ?? {}, patch); if (patch.error) console.log(`[${mode}] tool error: ${patch.error}`); save(); },
	async addMessage(s, item) { const next = { id: randomUUID(), ts: Date.now(), ...item }; s.messages.push(next); return next; }
};
function save() { fs.writeFileSync(path.join(outputDir, 'session.json'), JSON.stringify(session, null, 2)); }
const task = resumedSession && mode === 'sqa'
	? `Recover this unfinished controlled SQA qualification at ${fixture.url} from its durable activities and control observations. The exact fixture has been restored at the original loopback origin. Previous investigation already exercised microphone grant/probe/start/mute/unmute/stop, denied permission and recovery, native email validation, navigation and keyboard checks; inspect the stored evidence and reconcile completed plan items before acting. Do not repeat those checks when their evidence is sufficient. Scope of new browser work: test both meeting anchors with browser_test_meeting_link, snapshot each landing, return to the source tab, and inspect current diagnostics. Never join. Finish recording remaining browser-eligible controls from collected evidence, record reviewer-only missing prerequisites once with record_sqa_blockers, update the plan, and call finish_sqa_assessment. Do not claim missing assurance artifacts or new microphone coverage during recovery. Work within 30 tool calls; if a check cannot be established, record its specific blocker instead of repeatedly retrying keyboard or media. No credentials or questions are needed.`
	: resumedSession
	? `Complete the Founder report from this controlled qualification's existing durable observations. The saved browser investigation exercised the representative microphone practice workflow, meeting prejoin and expired links, forms, and navigation. Read the saved activities and observations to confirm evidence, then restore the canonical host plan below: earlier model turns renamed it and the finalizer requires the canonical representative-workflow checkpoint. Mark only evidence-backed completed work completed; leave synthesis in progress. If evidence is missing, report the blocker rather than inventing coverage. The temporary fixture is closed; do not browse. Then publish finish_founder_review with concise evidence-linked recommendations and clearly labeled assumptions. Preserve synthetic microphone and prejoin-only limitations. Do not claim new coverage during recovery. Canonical plan: ${JSON.stringify(createFounderReviewTodos())}`
	: focused
	? `Perform a focused QA regression on ${fixture.url}, an authorized isolated fixture. Scope only microphone mute semantics, native email validity, and meeting prejoin links. Open and snapshot, publish a short plan. Grant microphone and probe; start app microphone, mute, inspect track and snapshot meter/recorded bytes, unmute, stop, inspect cleanup. Evaluate mute using the browser contract in your instructions. Fill an invalid email and use browser_diagnostics formValidation to distinguish a native rejection from a submitted invalid form. Use browser_test_meeting_link for the test and expired anchors; snapshot each and return to the source. Never join. Mark scope complete and publish finish_qa_report promptly with synthetic-input and prejoin-only limitations. No credentials or questions are needed. Do not expand scope or repeat full navigation/accessibility checks.`
	: `Run a complete ${mode.toUpperCase()} qualification against ${fixture.url}. This is an explicitly authorized, isolated public-only fixture. Exercise: native microphone permission granted, browser_media probe, app Start microphone, actual input/recording feedback, mute, unmute, stop; permission denied with the app then permission recovery. Use browser_media inspect after app actions for actual track evidence. Test both the test meeting and expired meeting anchor with browser_test_meeting_link, inspect each landing then return to the source tab. Do not join the meeting. Expected expired link is intentional and must show a clear error, not silently pass. Test navigation, form validation, keyboard, diagnostics, and responsive signals. No credentials or user clarification is needed for this fixture. ${mode === 'sqa' ? 'Complete every scoped browser-eligible control with honest evidence, batch reviewer-only missing prerequisites using record_sqa_blockers, publish via finish_sqa_assessment. Missing assurance documents should produce a blocked overall verdict, which is expected.' : mode === 'founder' ? 'Map the route/surface inventory, complete a representative end-to-end workflow, capture evidence across every Founder category in batches, and publish the complete founder report with explicitly labeled assumptions.' : 'Publish finish_qa_report after all planned checks, listing synthetic audio and prejoin-only limitations.'} Work efficiently; batch closely related evidence and do not repeat completed checks. Never claim microphone or meeting coverage from only reading the page.`;
session.messages.push({ id: randomUUID(), role: 'user', text: task, ts: Date.now() });
const started = Date.now();
const maxMs = Math.min(1_800_000, Math.max(30_000, Number(process.env.QASE_QUALIFY_TIMEOUT_MS) || 900_000));
let timedOut = false;
const timer = setTimeout(() => { timedOut = true; live.controller?.abort(); }, maxMs);
try {
	await runTurn(session, { task }, store);
} finally {
	clearTimeout(timer);
	await live.bridge?.service?.dispose();
	live.dispose?.();
	await fixture?.close();
	if (timedOut) {
		session.status = 'error';
		session.statusDetail = `Qualification exceeded its ${maxMs / 1000}-second deadline.`;
	}
	save();
	const tools = session.activities.filter(a => a.status === 'done').map(a => a.toolName);
	const result = { mode, model: getConfig().model, node: process.version, sourceSession, qualification: sourceSession ? (mode === 'founder' ? 'recovered synthesis from existing browser evidence' : 'recovered SQA workflow with restored fixture and existing evidence') : focused ? 'focused media regression' : 'full mode workflow', completed: session.status === 'done', timedOut, status: session.status, elapsedMs: Date.now() - started, activities: session.activities.length, findings: session.findings.length, mediaUsed: tools.includes('browser_media'), meetingToolUsed: tools.includes('browser_test_meeting_link'), verdict: session.report?.verdict ?? session.sqa?.assessment?.verdict ?? (session.founder?.finalizedAt ? 'published' : undefined), outputDir };
	fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2));
	if (result.completed) fs.writeFileSync(path.join(outputDir, 'report.md'), mode === 'sqa' ? buildSqaReportMarkdown(session.sqa.assessment) : mode === 'founder' ? buildFounderReportMarkdown(session.founder) : buildReportMarkdown(session));
	console.log(JSON.stringify(result, null, 2));
	if (!result.completed || !result.mediaUsed || !result.meetingToolUsed) process.exitCode = 1;
}
