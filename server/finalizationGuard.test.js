import assert from 'node:assert/strict';
import test from 'node:test';
import { guardFinalization, isPublicationTodo, publicationTodos } from './finalizationGuard.js';
import { createFounderTools } from './founderTools.js';

test('finalization guard releases its flight after thrown errors and rechecks cancellation before dispatch',async()=>{
  const session={}; let calls=0, cancelled=false;
  const tool=guardFinalization({async run(){calls++;throw new Error('Fixture failure');}},session,{isCancelled:()=>cancelled});
  await assert.rejects(tool.run({}),/Fixture failure/);
  const pending=tool.run({});cancelled=true;
  assert.equal((await pending).code,'RUN_CANCELLED');assert.equal(calls,1);
});

for (const [mode, tool] of [['founder', 'finish_founder_review']]) {
  test(`${mode} literal publication task is recognized consistently without exempting technical work`, () => {
    for (const text of [tool, `Call ${tool}`, `Call ${tool} to publish deterministic verdict`]) {
      const todo = { text, status: 'in_progress' };
      assert.equal(isPublicationTodo(todo, mode), true);
      assert.equal(publicationTodos([todo], mode)[0].status, 'completed');
      assert.equal(isPublicationTodo({ ...todo, status: 'pending' }, mode), false);
    }
    for (const text of [`Test login then call ${tool}`, `Call ${tool} after testing login`, 'Review browser diagnostics']) {
      assert.equal(isPublicationTodo({ text, status: 'in_progress' }, mode), false);
    }
  });
}
