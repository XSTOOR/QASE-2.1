/**
 * Session-scoped credential vault.
 *
 * The point of holding credentials here rather than answering the agent's
 * question with them is that the model never sees the values. It fills forms
 * with `{{QA_PASSWORD}}`; the browser bridge swaps the placeholder for the real
 * string on its way to the keyboard, and the redactor scrubs anything that
 * leaks back out through a tool result or a page snapshot.
 */

const MASK = '••••••••';
const PLACEHOLDER = /\{\{\s*([A-Z0-9_]+)\s*\}\}/g;

/** id -> Map<name, value>. Lives only in this process; never persisted. */
const vaults = new Map();

export function vaultFor(sessionId) {
	let vault = vaults.get(sessionId);
	if (!vault) {
		vault = new Map();
		vaults.set(sessionId, vault);
	}
	return vault;
}

export function storeSecrets(sessionId, entries) {
	const vault = vaultFor(sessionId);
	const names = [];
	for (const [name, value] of Object.entries(entries)) {
		if (typeof value !== 'string' || value.length === 0) {
			continue;
		}
		const key = name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
		vault.set(key, value);
		names.push(key);
	}
	return names;
}

export function clearSecrets(sessionId) {
	vaults.delete(sessionId);
}

export function secretNames(sessionId) {
	return [...vaultFor(sessionId).keys()];
}

/** Substitutes `{{NAME}}` placeholders with their stored values. */
export function resolveSecrets(sessionId, text) {
	if (typeof text !== 'string' || !text.includes('{{')) {
		return text;
	}
	const vault = vaultFor(sessionId);
	return text.replace(PLACEHOLDER, (match, name) => vault.get(name) ?? match);
}

/** True when the text still holds an unresolved placeholder. */
export function hasUnresolvedPlaceholder(sessionId, text) {
	if (typeof text !== 'string') {
		return false;
	}
	const vault = vaultFor(sessionId);
	return [...text.matchAll(PLACEHOLDER)].some(match => !vault.has(match[1]));
}

/**
 * Deep-copies a value with every stored secret replaced by a mask. Applied to
 * everything that reaches the model or the dashboard, so a secret that ends up
 * in a page snapshot or an error message does not travel any further.
 */
export function redact(sessionId, value) {
	const vault = vaultFor(sessionId);
	if (vault.size === 0) {
		return value;
	}
	const secrets = [...vault.values()].filter(secret => secret.length >= 3);
	if (secrets.length === 0) {
		return value;
	}

	const scrubString = text => {
		let output = text;
		for (const secret of secrets) {
			if (output.includes(secret)) {
				output = output.split(secret).join(MASK);
			}
		}
		return output;
	};

	const walk = (input, depth) => {
		if (depth > 8) {
			return input;
		}
		if (typeof input === 'string') {
			return scrubString(input);
		}
		if (Array.isArray(input)) {
			return input.map(item => walk(item, depth + 1));
		}
		if (input && typeof input === 'object') {
			const output = {};
			for (const [key, item] of Object.entries(input)) {
				output[key] = walk(item, depth + 1);
			}
			return output;
		}
		return input;
	};

	return walk(value, 0);
}
