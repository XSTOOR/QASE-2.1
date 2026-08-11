import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Resolve one run's scratch directory without accepting arbitrary paths. */
export function resolveRunWorkspace(runId, options = {}) {
	if (typeof runId !== 'string' || !UUID_PATTERN.test(runId)) {
		throw new TypeError('Workspace cleanup requires a canonical run UUID.');
	}
	const root = path.resolve(options.root ?? path.join(process.cwd(), '.qase', 'workspaces'));
	const target = path.resolve(root, runId.toLowerCase());
	if (path.dirname(target) !== root) {
		throw new Error('Resolved run workspace escaped its configured root.');
	}
	return Object.freeze({ root, target });
}

/**
 * Remove only a validated per-run scratch directory. This is best-effort
 * application cleanup, not a claim of physical media zeroization.
 */
export async function purgeRunWorkspace(runId, options = {}) {
	const { target } = resolveRunWorkspace(runId, options);
	const filesystem = options.filesystem ?? fs;
	await filesystem.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
	return target;
}
