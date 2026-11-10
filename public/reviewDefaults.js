/** Choose only an explicitly available desktop runtime; preserve manual picks. */
export function defaultReviewEnvironment(environments = [], boardByEnvId = new Map()) {
	return environments.filter(env => {
		const board = boardByEnvId.get(env.envId ?? env.id);
		return env.active !== false && env.deviceType === 'desktop' && (env.envId ?? env.id)
			&& String(board?.status ?? env.runtimeStatus ?? env.availability ?? '').toUpperCase() === 'AVAILABLE';
	}).sort((a, b) => {
		const chrome = env => /^(chrome|chromium)$/i.test(env.browser ?? '') ? 0 : 1;
		return chrome(a) - chrome(b) || String(a.envId ?? a.id).localeCompare(String(b.envId ?? b.id));
	})[0] ?? null;
}
