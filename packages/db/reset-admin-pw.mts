import { createRequire } from 'node:module';
import { hashPassword } from '../../apps/api/src/lib/password.ts';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const db = new Database('../../data/stackpanel.db');
const hash = await hashPassword('AdminTest123');
const info = db.prepare('UPDATE users SET passwordHash=? WHERE email=?').run(hash, 'admin@stackpanel.local');
console.log('updated rows:', info.changes);
