import { createHash } from 'node:crypto';

export function authThrottleKey(value) {
	return createHash('sha256').update(String(value)).digest('hex');
}

export function createAuthThrottle({ now = Date.now } = {}) {
	const windows = new Map();
	return (key, limit) => {
		const time = now();
		for (const [id, entry] of windows) if (entry.expires <= time) windows.delete(id);
		if (!windows.has(key)) {
			if (windows.size >= 10_000) return false;
			windows.set(key, { count: 0, expires: time + 15 * 60_000 });
		}
		return ++windows.get(key).count <= limit;
	};
}
