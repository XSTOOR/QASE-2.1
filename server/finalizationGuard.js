// A mutable report is not published until its durable commit settles. Share
// that in-flight result even across tool factories for the same live session.
const publications = new WeakMap();

// Only the report-publication task exempted by the mode's readiness check may
// be completed by publication itself. Technical work keeps its own disposition.
export function isPublicationTodo(todo, mode) {
  if (todo?.status !== 'in_progress' || !['sqa', 'founder'].includes(mode)) return false;
  const pattern = mode === 'sqa'
    ? /\b(finish|publish)\b.*\b(SQA|assessment|report)\b/i
    : /\b(finish|publish)\b.*\b(founder|review|report)\b/i;
  const text = String(todo.text ?? '').trim();
  const tool = mode === 'sqa' ? 'finish_sqa_assessment' : 'finish_founder_review';
  // Accept the literal finalizer as a standalone publication instruction, not
  // an arbitrary technical task that happens to mention its tool name.
  const invocation = new RegExp('^(?:call\\s+)?`?' + tool + '`?(?:\\s+to\\s+publish\\s+(?:the\\s+)?(?:deterministic\\s+)?(?:verdict|assessment|review|report))?[.!]?$', 'i');
  return pattern.test(text) || invocation.test(text);
}

export function publicationTodos(todos, mode) {
  return todos?.map(todo => isPublicationTodo(todo, mode)
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
