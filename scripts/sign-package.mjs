import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const apiRequire = createRequire(path.join(root, 'apps', 'api', 'package.json'));
const { strToU8, unzipSync, zipSync } = apiRequire('fflate');

const [zipPath, privateKeyPath] = process.argv.slice(2);
if (!zipPath || !privateKeyPath) {
  console.error('Usage: node scripts/sign-package.mjs <package.zip> <ed25519-private.pem>');
  process.exit(1);
}

const zipBuffer = await readFile(zipPath);
const entries = unzipSync(zipBuffer);
const files = {};
for (const [name, data] of Object.entries(entries)) {
  if (name === 'signature.json') continue;
  files[name] = data;
}
const hashes = {};
for (const name of Object.keys(files).sort()) {
  hashes[name] = createHash('sha256').update(files[name]).digest('hex');
}
const payload = Buffer.from(JSON.stringify({ algorithm: 'ed25519', files: hashes }), 'utf8');
const privateKey = await readFile(privateKeyPath);
const signature = sign(null, payload, createPrivateKey(privateKey)).toString('base64');
entries['signature.json'] = strToU8(
  `${JSON.stringify({ algorithm: 'ed25519', files: hashes, signature }, null, 2)}\n`,
);
await writeFile(zipPath, Buffer.from(zipSync(entries)));
console.log(`Signed ${zipPath}`);
