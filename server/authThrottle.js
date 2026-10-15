import { createHash } from 'node:crypto';

export function authThrottleKey(value) {
	return createHash('sha256').update(String(value)).digest('hex');
}

const WINDOW_MS = 15 * 60_000;
const MAX_KEYS = 10_000;

export function createAuthThrottle({ now = Date.now } = {}) {
	const windows = new Map();
	const sweep = time => {
		for (const [id, entry] of windows) {
			if (entry.expires <= time) windows.delete(id);
		}
	};
	return (key, limit) => {
		const time = now();
		sweep(time);
		if (!windows.has(key)) {
			if (windows.size >= MAX_KEYS) {
				let toEvict = windows.size - MAX_KEYS + 1;
				for (const id of windows.keys()) {
					if (toEvict-- <= 0) break;
					windows.delete(id);
				}
			}
			windows.set(key, { count: 0, expires: time + WINDOW_MS });
		}
		return ++windows.get(key).count <= limit;
	};
}
