import 'dotenv/config';

// Read credentials from the local environment; never print request headers.
const endpoint = 'https://llm.drytis.ai/typesafe/api/alpha/decisions';
const key = process.env.JEV_API_KEY;
if (!key) throw new Error('JEV_API_KEY is required.');
const paths = process.argv.slice(2);
for (const target of paths.length ? paths : [endpoint]) {
  const url = new URL(target, endpoint);
  if (url.origin !== new URL(endpoint).origin) throw new Error('Only the configured JEV origin can be probed.');
  const options = { redirect: 'error', signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } };
  if (url.pathname.endsWith('/chat/completions')) {
    options.method = 'POST';
    options.body = JSON.stringify({ model: url.pathname.startsWith('/typesafe/') ? 'typesafe/jev-1.13' : 'drytis/jev-1.13', messages: [{ role: 'user', content: 'Reply ready.' }], max_tokens: 32, stream: false });
  } else if (url.href === endpoint) {
    options.method = 'POST';
    options.body = JSON.stringify({ model: 'jev-1.13', state: 'The service is online and ready.', questions: { ready: { type: 'noul', instructions: 'Is the service ready?' } } });
  }
  try {
    const response = await fetch(url, options);
    const body = await response.text();
    let summary = body;
    if (url.pathname.endsWith('/models') && response.ok) {
      const data = JSON.parse(body);
      summary = { models: (data.data ?? []).filter(model => /jev/i.test(model.id)) };
    } else if (url.pathname.includes('openapi') && response.ok) {
      const spec = JSON.parse(body);
      summary = { info: spec.info, paths: Object.fromEntries(Object.entries(spec.paths ?? {}).filter(([path]) => /decision/.test(path))) };
      const refs = new Set(JSON.stringify(summary).match(/#\/components\/schemas\/[^" ]+/g) ?? []);
      const schemas = {};
      for (const ref of refs) {
        const name = ref.split('/').at(-1);
        if (!name.startsWith('Decisions')) continue;
        schemas[name] = spec.components?.schemas?.[name];
        for (const next of JSON.stringify(schemas[name] ?? {}).match(/#\/components\/schemas\/[^" ]+/g) ?? []) refs.add(next);
      }
      summary.schemas = schemas;
    }
    console.log(JSON.stringify({ url: url.href, status: response.status, body: typeof summary === 'string' ? summary.replaceAll(key, '[REDACTED]').slice(0, 3000) : summary }));
  } catch (error) { console.log(JSON.stringify({ url: url.href, error: error.name, code: error.cause?.code })); }
}
