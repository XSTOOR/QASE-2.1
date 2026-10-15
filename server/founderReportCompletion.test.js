import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function fixture(session) {
	const calls = [];
	const state = { session };
	const context = vm.createContext({ state, el: { reportTab: 'report' }, activateDetailTab: tab => calls.push(tab) });
	const fn = source.match(/function showCompletedFounderReport\(\) \{[\s\S]*?\n\}/)?.[0];
	assert.ok(fn, 'completion selection handler exists');
	vm.runInContext(fn, context);
	return { state, calls, show: () => vm.runInContext('showCompletedFounderReport()', context) };
}
const completed = () => ({ id: 'one', mode: 'founder', status: 'done', founder: { report: {}, finalizedAt: 'today' } });

test('completed Founder report opens once, and a new report opens again', () => {
	const f = fixture(completed());
	f.show(); f.show();
	assert.deepEqual(f.calls, ['report']);
	f.state.session.founder.finalizedAt = 'tomorrow';
	f.show();
	assert.equal(f.calls.length, 2);
});
test('report and status can arrive in either order', () => {
	for (const missing of ['status', 'report']) {
		const session = completed();
		if (missing === 'status') session.status = 'running';
		else delete session.founder.report;
		const f = fixture(session);
		f.show(); assert.equal(f.calls.length, 0);
		session.status = 'done'; session.founder.report = {};
		f.show(); assert.equal(f.calls.length, 1);
	}
});
test('unfinished runs and other modes do not select a report', () => {
	for (const overrides of [{ status: 'error' }, { status: 'idle' }, { status: 'awaiting_input' }, { mode: 'qa' }, { mode: 'sqa' }, { founder: { report: {} } }]) {
		const f = fixture({ ...completed(), ...overrides });
		f.show(); assert.equal(f.calls.length, 0);
	}
});
