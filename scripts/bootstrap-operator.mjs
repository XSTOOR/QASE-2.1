// One-time, offline bootstrap for an EMPTY local authentication store only.
// Stop the application first; never run concurrently with its JSON store.
import fs from 'node:fs';
import path from 'node:path';
import { createLocalAuthService } from '../server/auth.js';
import { createTenantContext } from '../server/tenancy.js';
if (process.env.QASE_RUN_STORE !== 'local') throw new Error('This bootstrap supports the local store only.');
const file = path.join(process.cwd(), '.qase/auth.json');
if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).users?.length) throw new Error('Accounts already exist. Use the existing operator; no changes made.');
const email = process.env.QASE_OPERATOR_EMAIL;
const password = process.env.QASE_OPERATOR_PASSWORD;
if (!email || !password || password.length < 14) throw new Error('Supply operator email and a unique password of at least 14 characters through protected environment variables.');
const auth = createLocalAuthService({ tenantContext: createTenantContext() });
await auth.register({ email, password, displayName: 'QASE Operator' });
console.log('Initial operator account created. No credential or session token is printed.');
