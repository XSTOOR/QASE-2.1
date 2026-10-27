// Execution lifecycle is not a test verdict. Older runs encode dispositions
// in their final text, so render those honestly without rewriting history.
export function planPresentation(todo) {
  const status = todo.status || 'pending';
  const disposition = status === 'completed' && String(todo.text || '').match(/ — (not_tested|not_executed|not_observed|partial|tested|inconclusive|blocked|failed|passed):/u)?.[1];
  const key = disposition || status;
  return {
    key,
    label: { completed: 'Completed', passed: 'Passed', inconclusive: 'Inconclusive', in_progress: 'Running', failed: 'Failed', blocked: 'Blocked', not_tested: 'Not tested', not_executed: 'Not executed', not_observed: 'Not observed', partial: 'Partial', tested: 'Tested' }[key] || 'Queued',
    mark: ['inconclusive', 'partial', 'not_tested', 'not_executed', 'not_observed'].includes(key) ? '—' : key === 'failed' ? '!' : key === 'in_progress' ? '◉' : ['passed', 'completed', 'tested'].includes(key) ? '✓' : '○'
  };
}
