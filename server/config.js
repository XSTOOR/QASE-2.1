import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Model settings, resolved from the settings file first and the environment
 * second, so the dashboard can point Qase at a custom endpoint without anyone
 * editing .env and restarting.
 *
 * The `custom` provider is an OpenAI-compatible endpoint: the three things it
 * needs are a key, a base URL and a model name.
 */

const CONFIG_DIR = path.join(process.cwd(), '.qase');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export const PROVIDERS = [
	'custom', 'anthropic', 'openai', 'azureOpenAI', 'gemini',
	'grok', 'nvidia', 'openrouter', 'bedrock'
];

/** Providers that will not start without a base URL of their own. */
const NEEDS_BASE_URL = new Set(['custom', 'azureOpenAI']);

let stored;

function readStored() {
	if (stored) {
		return stored;
	}
	try {
		stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
	} catch {
		stored = {};
	}
	return stored;
}

function fromEnv() {
	return {
		provider: process.env.QASE_PROVIDER,
		apiKey: process.env.QASE_API_KEY ?? process.env.ANTHROPIC_API_KEY,
		baseUrl: process.env.QASE_BASE_URL,
		model: process.env.QASE_MODEL,
		reasoning: process.env.QASE_REASONING,
		maxTurns: process.env.QASE_MAX_TURNS ? Number(process.env.QASE_MAX_TURNS) : undefined,
		headless: process.env.QASE_HEADLESS === undefined ? undefined : process.env.QASE_HEADLESS !== 'false'
	};
}

const DEFAULTS = {
	provider: 'anthropic',
	apiKey: '',
	baseUrl: '',
	model: 'claude-opus-5',
	reasoning: 'medium',
	maxTurns: 120,
	headless: true
};

/** The effective settings the agent runs with. Includes the key — server only. */
export function getConfig() {
	const merged = { ...DEFAULTS };
	for (const source of [fromEnv(), readStored()]) {
		for (const [key, value] of Object.entries(source)) {
			if (value !== undefined && value !== null && value !== '') {
				merged[key] = value;
			}
		}
	}
	return merged;
}

/** The same settings with the key reduced to a hint. Safe to send to a browser. */
export function getPublicConfig() {
	const config = getConfig();
	return {
		provider: config.provider,
		baseUrl: config.baseUrl,
		model: config.model,
		reasoning: config.reasoning,
		maxTurns: config.maxTurns,
		headless: config.headless,
		hasApiKey: Boolean(config.apiKey),
		apiKeyHint: config.apiKey ? `••••${config.apiKey.slice(-4)}` : '',
		apiKeyFromEnv: Boolean(fromEnv().apiKey) && !readStored().apiKey,
		providers: PROVIDERS,
		ready: isReady(config),
		problem: describeProblem(config)
	};
}

function isReady(config = getConfig()) {
	return !describeProblem(config);
}

function describeProblem(config) {
	if (config.provider !== 'bedrock' && !config.apiKey) {
		return 'No API key set.';
	}
	if (NEEDS_BASE_URL.has(config.provider) && !config.baseUrl) {
		return 'This provider needs a base URL.';
	}
	if (!config.model) {
		return 'No model name set.';
	}
	return undefined;
}

export function saveConfig(patch) {
	const next = { ...readStored() };
	for (const key of ['provider', 'apiKey', 'baseUrl', 'model', 'reasoning']) {
		if (typeof patch[key] === 'string') {
			next[key] = patch[key].trim();
		}
	}
	if (patch.maxTurns !== undefined) {
		next.maxTurns = Math.max(10, Math.min(500, Number(patch.maxTurns) || DEFAULTS.maxTurns));
	}
	if (patch.headless !== undefined) {
		next.headless = Boolean(patch.headless);
	}
	if (next.provider && !PROVIDERS.includes(next.provider)) {
		throw new Error(`Unknown provider: ${next.provider}`);
	}

	stored = next;
	fs.mkdirSync(CONFIG_DIR, { recursive: true });
	fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, undefined, '\t'), { mode: 0o600 });
	return getPublicConfig();
}

/** Trims a base URL to its origin+path root, so `/models` can be appended. */
function normaliseBase(baseUrl) {
	return baseUrl.trim().replace(/\/+$/, '');
}

/**
 * Probes an OpenAI-compatible endpoint's model list. It is a reachability and
 * credential check, not a guarantee — some gateways do not implement /models,
 * so a failure here is reported as a warning rather than a hard error.
 */
export async function testConnection(candidate) {
	const config = { ...getConfig(), ...candidate };
	const problem = describeProblem(config);
	if (problem) {
		return { ok: false, error: problem };
	}
	if (!config.baseUrl) {
		return { ok: true, skipped: true, message: `${config.provider} uses its own endpoint; nothing to probe.` };
	}

	const url = `${normaliseBase(config.baseUrl)}/models`;
	try {
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
			signal: AbortSignal.timeout(12_000)
		});
		if (!response.ok) {
			return {
				ok: false,
				error: `${url} returned ${response.status}. ${response.status === 401 ? 'The key was rejected.' : 'Check the base URL.'}`
			};
		}
		const body = await response.json().catch(() => ({}));
		const models = (body.data ?? body.models ?? [])
			.map(entry => entry?.id ?? entry?.name)
			.filter(Boolean);
		return {
			ok: true,
			models: models.slice(0, 200),
			matched: models.length === 0 ? undefined : models.includes(config.model),
			message: models.length > 0
				? `Reachable — ${models.length} model(s) listed.`
				: 'Reachable, but the endpoint listed no models.'
		};
	} catch (error) {
		return { ok: false, error: `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}` };
	}
}
