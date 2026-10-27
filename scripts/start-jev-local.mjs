import 'dotenv/config';
import { createJevTestServer } from './jev-test-server.mjs';
import { getConfig } from '../server/config.js';

if (process.env.NODE_ENV === 'production') throw new Error('The JEV model lab is for local development only.');
process.env.NODE_ENV ??= 'development';
process.env.QASE_PROVIDER ??= 'jev';
process.env.QASE_MODEL ??= 'jev-1.13';
process.env.QASE_HOST ??= '127.0.0.1';
process.env.PORT ??= '5174';
if (getConfig().provider !== 'jev') throw new Error('Saved configuration overrides JEV. Select the JEV provider before using start:jev.');
const lab = createJevTestServer({ apiKey: getConfig().apiKey });
await new Promise((resolve, reject) => { lab.once('error', reject); lab.listen(5175, '127.0.0.1', resolve); });
lab.unref();
console.log('JEV Decisions model lab: http://127.0.0.1:5175');
try { await import('../server/index.js'); } catch (error) { lab.close(); throw error; }
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => lab.close());
