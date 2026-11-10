/** One explicit qualification request followed by bounded, read-only polling.
 * The server owns readiness. Never change browser/check selections or assume
 * that a refresh, HTTP success, or elapsed time means qualification passed. */
export async function renewHybridQualification({ api, onConfig, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), maxPolls = 150 }) {
  let config = await api('/config/hybrid/qualification', { method: 'POST', body: '{}' });
  onConfig(config);
  // A subsequent GET can land on another API replica before the shared
  // certificate is replaced. Stale/absent proof still blocks launch, but must
  // not be mistaken for a finished check. No additional POST is sent.
  const pending = () => ['qualification_running', 'qualification_expired', 'qualification_required'].includes(config.hybridQa?.status);
  for (let count = 0; pending() && count < maxPolls; count++) {
    await wait(1500);
    config = await api('/config');
    onConfig(config);
  }
  if (!config.hybridQa?.available) throw new Error(pending()
    ? 'The compatibility check is still running. Select Check model compatibility to reconnect; your setup is saved.'
    : config.hybridQa?.reason || 'Model compatibility could not be verified. Your test setup is saved.');
  return config;
}
