/** Import only model configuration, not unrelated legacy app/DB settings. */
export function platformEnvironment(settings, environment = {}) {
	const imported = {};
	const aliases = {
		QASE_API_KEY: settings.QASE_API_KEY || settings.CUSTOM_API_KEY,
		QASE_BASE_URL: settings.QASE_BASE_URL || settings.CUSTOM_BASE_URL,
		QASE_MODEL: settings.QASE_MODEL || settings.CUSTOM_MODEL,
		QASE_PROVIDER: settings.QASE_PROVIDER || (settings.CUSTOM_API_KEY ? 'custom' : undefined)
	};
	for (const [key, value] of Object.entries(aliases)) {
		if (!environment[key] && value) imported[key] = value;
	}
	return imported;
}
