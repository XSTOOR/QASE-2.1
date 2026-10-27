/** Native TypeSafe Decisions transport. No chat proxy or fallback model. */
export const JEV_ENDPOINT = 'https://llm.drytis.ai/typesafe/api/alpha/decisions';
export const JEV_MODEL = 'jev-1.13';
export const JEV_CAPABILITIES = Object.freeze({ decisions: true, textGeneration: false, nativeToolCalls: false, controller: 'coverage-decisions-v2' });

export function isJevModel(value) {
  return /^(?:typesafe\/)?jev-1\.13(?:-\d{8})?$/.test(String(value));
}

export function validateJevConfiguration({ apiKey, baseUrl = JEV_ENDPOINT, model = JEV_MODEL }) {
  if (!apiKey) throw new Error('JEV_API_KEY is missing.');
  if (baseUrl !== JEV_ENDPOINT) throw new Error('JEV uses the fixed TypeSafe Decisions endpoint.');
  if (!isJevModel(model)) throw new Error('The JEV-only controller requires jev-1.13.');
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validateQuestions(questions) {
  const entries = Object.entries(questions ?? {});
  if (!object(questions) || entries.length < 1 || entries.length > 50) throw new Error('Provide 1–50 decision questions.');
  for (const [id, question] of entries) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !object(question) || typeof question.instructions !== 'string' || !question.instructions.trim() || question.instructions.length > 8000) throw new Error('Invalid JEV question.');
    if (!['noul', 'choice', 'score'].includes(question.type)) throw new Error('The QASE controller supports noul, choice, and score decisions.');
    if (question.type === 'choice' && (!object(question.criteria) || Object.keys(question.criteria).length < 2 || Object.keys(question.criteria).length > 30)) throw new Error('A choice needs 2–30 candidates.');
    if (question.type === 'score' && (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10)) throw new Error('A score needs 2–10 ordered criteria.');
  }
}

/** Validate the exact wire payload before reserving or dispatching a call. */
export function prepareJevRequest(state, questions, { model = JEV_MODEL, sessionId } = {}) {
  validateQuestions(questions);
  const body = JSON.stringify({ model, state, questions, ...(sessionId ? { session_id: sessionId } : {}) });
  if (Buffer.byteLength(body) > 200000) throw new Error('JEV request exceeded the context limit.');
  return body;
}

function usageReceipt(body) {
  const inputTokens = body?.usage?.input_tokens, outputTokens = body?.usage?.output_tokens;
  if (!isJevModel(body?.model) || body?.usage?.estimated === true ||
      ![inputTokens, outputTokens, inputTokens + outputTokens].every(value => Number.isSafeInteger(value) && value >= 0) ||
      (body.usage.total_tokens !== undefined && body.usage.total_tokens !== inputTokens + outputTokens)) throw new Error('JEV returned invalid token usage.');
  return { callId: typeof body.id === 'string' ? body.id : undefined, estimated: false, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
    ...(Number.isFinite(body.usage.cost) && body.usage.cost >= 0 ? { cost: body.usage.cost } : {}) };
}

export function validateJevResponse(body, questions) {
  if (!object(body) || !isJevModel(body.model) || !object(body.answers)) throw new Error('JEV returned an invalid model or decision response.');
  for (const [id, question] of Object.entries(questions)) {
    const answer = body.answers[id];
    if (!object(answer) || answer.type !== question.type) throw new Error(`JEV omitted or mistyped decision ${id}.`);
    if (answer.type === 'choice' && !Object.hasOwn(question.criteria, answer.choice)) throw new Error(`JEV selected an unknown candidate for ${id}.`);
    if (answer.type === 'noul' && (!Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)) throw new Error(`JEV returned an invalid probability for ${id}.`);
    if (answer.type === 'score' && (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1)) throw new Error(`JEV returned an invalid score for ${id}.`);
    if (answer.confidence !== undefined && (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1)) throw new Error('JEV returned invalid confidence.');
  }
  usageReceipt(body);
  return body;
}

async function boundedJson(response) {
  if (!/\bapplication\/(?:[\w.+-]*\+)?json\b/i.test(response.headers.get('content-type') ?? '')) throw new Error('JEV returned a non-JSON response.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('JEV response exceeded the size limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('JEV returned invalid JSON.'); }
}

export function createJevClient(configuration, { fetchImpl = fetch, timeoutMs = 60000, onUsage } = {}) {
  const settings = { baseUrl: JEV_ENDPOINT, model: JEV_MODEL, ...configuration };
  validateJevConfiguration(settings);
  return {
    async decide(state, questions, { signal, sessionId, onDispatch, onUsageReceipt } = {}) {
      const body = prepareJevRequest(state, questions, { model: settings.model, sessionId });
      signal?.throwIfAborted();
      let response;
      let stage = 'transport';
      try {
        onDispatch?.();
        response = await fetchImpl(settings.baseUrl, {
          method: 'POST', redirect: 'error',
          signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(120000, timeoutMs))), ...(signal ? [signal] : [])]),
          headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body
        });
        if (!response.ok) {
          await response.body?.cancel();
          const detail = [401, 403].includes(response.status) ? 'Authentication was rejected.' : response.status === 429 ? 'Rate limit reached; retry later.' : 'The gateway rejected the decision request.';
          throw Object.assign(new Error(`JEV HTTP ${response.status}. ${detail}`), { code: 'JEV_HTTP_REJECTED', httpStatus: response.status });
        }
        stage = 'response';
        const raw = await boundedJson(response);
        const sanitized = JSON.parse(JSON.stringify(raw).replaceAll(settings.apiKey, '[REDACTED]'));
        // Billing and decision validity are independent. Persist a verified
        // receipt even if answer validation or late cancellation rejects output.
        stage = 'usage';
        const receipt = usageReceipt(sanitized);
        await onUsageReceipt?.(receipt);
        onUsage?.(receipt);
        stage = 'answers';
        const result = validateJevResponse(sanitized, questions);
        signal?.throwIfAborted();
        return result;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        // Never return upstream echoes, headers, or fetch's request details.
        if (error.name === 'TimeoutError') throw Object.assign(new Error('JEV decision request timed out.'), { code: 'JEV_TIMEOUT', stage });
        if (error.message?.startsWith('JEV ')) { error.code ??= stage === 'answers' ? 'JEV_RESPONSE_INVALID' : stage === 'usage' ? 'JEV_USAGE_UNVERIFIED' : 'JEV_RESPONSE_UNREADABLE'; error.stage = stage; throw error; }
        if (error.code?.startsWith('HYBRID_')) throw error;
        throw Object.assign(new Error('JEV decision connection failed. Check gateway connectivity.'), { code: 'JEV_CONNECTION_FAILED', stage });
      }
    }
  };
}
