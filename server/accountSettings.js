import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export function accountSettingsCodec({ file, environment = process.env } = {}) {
	let pending;
	async function key() {
		if (!pending) pending = (async () => {
			if (environment.QASE_SECRETS_MASTER_KEY) {
				const value = Buffer.from(environment.QASE_SECRETS_MASTER_KEY, 'base64url');
				if (value.length !== 32) throw new Error('QASE_SECRETS_MASTER_KEY must encode 32 bytes.');
				return value;
			}
			if (!file || environment.NODE_ENV === 'production') throw new Error('Account settings require QASE_SECRETS_MASTER_KEY in production.');
			await fs.mkdir(path.dirname(file), { recursive: true });
			try { await fs.writeFile(`${file}.key`, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
			catch (error) { if (error.code !== 'EEXIST') throw error; }
			const value = await fs.readFile(`${file}.key`);
			if (value.length !== 32) throw new Error('Invalid account settings key.');
			return value;
		})();
		return pending;
	}
	return {
		async seal(userId, settings) {
			const iv = randomBytes(12);
			const cipher = createCipheriv('aes-256-gcm', await key(), iv);
			cipher.setAAD(Buffer.from(userId));
			const data = Buffer.concat([cipher.update(JSON.stringify(settings)), cipher.final()]);
			return { v: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url') };
		},
		async open(userId, envelope) {
			if (!envelope) return {};
			if (envelope.v !== 1) throw new Error('Invalid account settings format.');
			const decipher = createDecipheriv('aes-256-gcm', await key(), Buffer.from(envelope.iv, 'base64url'));
			decipher.setAAD(Buffer.from(userId));
			decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
			return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64url')), decipher.final()]).toString('utf8'));
		}
	};
}
