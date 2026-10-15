import assert from 'node:assert/strict';
import test from 'node:test';
import {
	applyStatusTiming, markReportPhase, markExecutionStarted, timingForEvent,
	activeDurationSeconds, setStatus, emit
} from './store.js';

function freshSession() {
	return { id: 'test-run', status: 'idle', createdAt: Date.now(), updatedAt: Date.now() };
}

test('running transition sets startedAt and setupStartedAt once', () => {
	const session = freshSession();
	applyStatusTiming(session, 'running');
	const first = session.startedAt;
	assert.equal(session.setupStartedAt, first);
	// A repeat transition must never reset the timer.
	applyStatusTiming(session, 'running');
	assert.equal(session.startedAt, first);
});

test('done transition sets completedAt once and never resets', () => {
	const session = freshSession();
	applyStatusTiming(session, 'running');
	applyStatusTiming(session, 'done');
	const done = session.completedAt;
	assert.ok(done >= session.startedAt);
	applyStatusTiming(session, 'done');
	assert.equal(session.completedAt, done);
});

test('error transition records completion and preserves failureReason', () => {
	const session = freshSession();
	applyStatusTiming(session, 'running');
	applyStatusTiming(session, 'error');
	assert.ok(session.completedAt);
	session.failureReason = 'Model connection lost';
	applyStatusTiming(session, 'done');
	// A done transition clears the failure reason only on a genuine success path.
	assert.equal(session.failureReason, undefined);
});

test('idle after running records a pause, not a cancellation', () => {
	const session = freshSession();
	applyStatusTiming(session, 'running');
	applyStatusTiming(session, 'idle');
	// Stop pauses the timer; it must not be cancelled or completed.
	assert.ok(session.pausedAt);
	assert.equal(session.cancelledAt, undefined);
	assert.equal(session.completedAt, undefined);
});

test('resume after pause continues elapsed time and accumulates pause seconds', async () => {
	const session = freshSession();
	applyStatusTiming(session, 'running');
	const startedAt = session.startedAt;
	await new Promise(resolve => setTimeout(resolve, 30));
	applyStatusTiming(session, 'idle'); // pause
	const pausedAt = session.pausedAt;
	await new Promise(resolve => setTimeout(resolve, 30));
	applyStatusTiming(session, 'running'); // resume
	assert.equal(session.pausedAt, undefined);
	assert.equal(session.startedAt, startedAt, 'resume keeps the original start');
	assert.ok(session.pausedSeconds >= 0.02, 'pause interval accumulated');
	// Further pause/resume cycles keep accumulating without loss: pause for a
	// measurable interval, then resume.
	await new Promise(resolve => setTimeout(resolve, 20));
	applyStatusTiming(session, 'idle');
	const beforeSecond = session.pausedSeconds;
	await new Promise(resolve => setTimeout(resolve, 20));
	applyStatusTiming(session, 'running');
	assert.ok(session.pausedSeconds > beforeSecond, 'multiple cycles accumulate');
	const active = activeDurationSeconds(session);
	assert.ok(active <= (Date.now() - startedAt) / 1000, 'paused time excluded from active duration');
});

test('completing while paused closes the pause interval', async () => {
	const session = freshSession();
	applyStatusTiming(session, 'running');
	applyStatusTiming(session, 'idle');
	const pausedSecondsBefore = session.pausedSeconds ?? 0;
	await new Promise(resolve => setTimeout(resolve, 20)); // pause for a real interval
	applyStatusTiming(session, 'done');
	assert.equal(session.pausedAt, undefined);
	assert.ok((session.pausedSeconds ?? 0) > pausedSecondsBefore, 'open pause interval closed on done');
	assert.ok(session.completedAt);
});

test('pause freeze: active duration does not advance while paused', async () => {
	const session = freshSession();
	applyStatusTiming(session, 'running');
	await new Promise(resolve => setTimeout(resolve, 40));
	applyStatusTiming(session, 'idle');
	const frozen = activeDurationSeconds(session);
	await new Promise(resolve => setTimeout(resolve, 60));
	assert.equal(activeDurationSeconds(session), frozen, 'elapsed frozen while paused');
});

test('interrupted pauses the timer instead of closing it', async () => {
	const session = freshSession();
	applyStatusTiming(session, 'running');
	await new Promise(resolve => setTimeout(resolve, 30));
	applyStatusTiming(session, 'interrupted');
	// Stuck / interrupted must PAUSE, not complete or cancel: elapsed is
	// frozen at the interruption point and the run stays resumable.
	assert.equal(session.completedAt, undefined, 'interrupted is not terminal');
	assert.equal(session.cancelledAt, undefined, 'interrupted never cancels');
	assert.ok(Number.isFinite(session.pausedAt), 'pausedAt set on interruption');
	const frozen = activeDurationSeconds(session);
	await new Promise(resolve => setTimeout(resolve, 50));
	assert.equal(activeDurationSeconds(session), frozen, 'elapsed frozen while interrupted');
	// Recovery resumes from the frozen value and accumulates the gap.
	applyStatusTiming(session, 'running');
	assert.equal(session.pausedAt, undefined);
	assert.ok(session.pausedSeconds >= 0.05, 'interruption gap excluded from active time');
	applyStatusTiming(session, 'done');
	assert.ok(session.completedAt, 'completes after interruption');
});

test('timingForEvent carries pause fields', () => {
	const session = freshSession();
	applyStatusTiming(session, 'running');
	applyStatusTiming(session, 'idle');
	const timing = timingForEvent(session);
	assert.ok(Number.isFinite(timing.pausedAt));
	assert.equal(timing.pausedSeconds, 0);
});

test('idle before any run never sets cancellation timestamps', () => {
	const session = freshSession();
	applyStatusTiming(session, 'idle');
	assert.equal(session.cancelledAt, undefined);
	assert.equal(session.completedAt, undefined);
});

test('report phase boundaries only close when opened', () => {
	const session = freshSession();
	markReportPhase(session, 'end');
	assert.equal(session.reportEndedAt, undefined);
	markReportPhase(session, 'start');
	markReportPhase(session, 'end');
	assert.ok(session.reportStartedAt <= session.reportEndedAt);
});

test('execution start closes the setup phase', () => {
	const session = freshSession();
	applyStatusTiming(session, 'running');
	markExecutionStarted(session);
	assert.ok(session.setupEndedAt >= session.setupStartedAt);
	// Idempotent.
	const ended = session.setupEndedAt;
	markExecutionStarted(session);
	assert.equal(session.setupEndedAt, ended);
});

test('timingForEvent carries serverNow and all timing fields', () => {
	const session = freshSession();
	applyStatusTiming(session, 'running');
	const timing = timingForEvent(session);
	assert.ok(timing.serverNow > 0);
	assert.ok(timing.startedAt > 0);
	assert.equal(timing.failureReason, undefined);
});
