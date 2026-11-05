// A mutable report is not published until its durable commit settles. Share
// that in-flight result even across tool factories for the same live session.
const publications = new WeakMap();

// Only the report-publication task exempted by the mode's readiness check may
// be completed by publication itself. Technical work keeps its own disposition.
export function publicationTodos(todos, mode) {
  const pattern = mode === 'sqa'
    ? /\b(finish|publish)\b.*\b(SQA|assessment|report)\b/i
    : /\b(finish|publish)\b.*\b(founder|review|report)\b/i;
  return todos?.map(todo => todo.status === 'in_progress' && pattern.test(todo.text ?? '')
    ? { ...todo, status: 'completed' } : todo);
}

export function guardFinalization(tool, session, { isCancelled } = {}) {
  return { ...tool, async run(input, context = {}) {
    const cancelled = () => context.signal?.aborted || isCancelled?.();
    const refusal = () => ({ success: false, code: 'RUN_CANCELLED', error: 'This execution was cancelled; no new report can be published.' });
    if (cancelled()) return refusal();
    let pending = publications.get(session);
    if (pending) return pending;
    pending = Promise.resolve().then(() => cancelled() ? refusal() : tool.run(input, context));
    publications.set(session, pending);
    try { return await pending; }
    finally { if (publications.get(session) === pending) publications.delete(session); }
  } };
}
