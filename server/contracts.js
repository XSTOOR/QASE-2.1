/**
 * Runtime contract for the application layer.
 *
 * Qase is currently backed by local files and process memory. Express routes
 * depend on this contract instead of importing those implementations directly,
 * so later phases can introduce PostgreSQL, a broker and a secrets manager
 * without rewriting the HTTP surface at the same time.
 */

const REQUIRED_METHODS = {
	runs: [
		'load', 'create', 'get', 'list', 'delete',
		'commit', 'addMessage', 'addActivity', 'updateActivity', 'setStatus'
	],
	events: ['publish', 'subscribe'],
	configuration: ['getPublic', 'save', 'testConnection'],
	secrets: ['clear', 'names', 'store'],
	reports: ['buildMarkdown'],
	agent: [
		'ensureRuntime', 'runTurn', 'closeBrowser', 'getLiveState',
		'stop', 'invalidateIdleRuntimes'
	],
	readiness: ['check'],
	lifecycle: ['close']
};

export function assertApplicationServices(services) {
	if (!services || typeof services !== 'object') {
		throw new TypeError('Application services are required.');
	}

	for (const [group, methods] of Object.entries(REQUIRED_METHODS)) {
		const implementation = services[group];
		if (!implementation || typeof implementation !== 'object') {
			throw new TypeError(`Application service group is missing: ${group}`);
		}
		for (const method of methods) {
			if (typeof implementation[method] !== 'function') {
				throw new TypeError(`Application service method is missing: ${group}.${method}`);
			}
		}
	}

	return services;
}
