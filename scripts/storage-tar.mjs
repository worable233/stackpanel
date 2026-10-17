#!/usr/bin/env node
/**
 * Stream every object in the configured object store as a tar archive, and
 * stream a tar archive back into the store.
 *
 * Why this exists: `scripts/backup.sh` used to tar the local `STACKPANEL_DATA_DIR`
 * only. In a docker-compose deployment the storage driver is S3 (bundled MinIO),
 * so uploaded media never live on the host — the archive silently contained no
 * attachments at all. The API's in-app export already handles this generically
 * (`StorageDriver.list()`), but the host-side ops scripts had no equivalent.
 * This script gives them one without requiring `mc`, extra images, or bind
 * mounts: it runs either on the host or inside the api container.
 *
 * Usage (tar on stdout / tar on stdin):
 *   node scripts/storage-tar.mjs export > media.tar
 *   node scripts/storage-tar.mjs import < media.tar
 *
 * Configuration is read from the environment exactly like the API:
 *   STORAGE_DRIVER=s3
 *   STORAGE_S3_ENDPOINT / _REGION / _BUCKET / _ACCESS_KEY_ID /
 *   STORAGE_S3_SECRET_ACCESS_KEY / STORAGE_S3_FORCE_PATH_STYLE
 *
 * Only `s3` is supported here. The `local` driver's bytes already sit in
 * `STACKPANEL_DATA_DIR`, which the shell script archives directly.
 */
const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK);

const command = process.argv[2];
if (command !== 'export' && command !== 'import') {
  console.error('用法：node scripts/storage-tar.mjs <export|import>');
  process.exit(2);
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`错误：缺少 ${name}（storage-tar 需要 S3 配置）。`);
    process.exit(1);
  }
  return value;
}

const driver = process.env.STORAGE_DRIVER ?? 's3';
if (driver !== 's3') {
  console.error(
    `错误：storage-tar 只处理 s3 驱动（当前 STORAGE_DRIVER=${driver}）。` +
      ' local 驱动的数据已在 STACKPANEL_DATA_DIR 中。',
  );
  process.exit(1);
}

const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = await loadAwsSdk();

/**
 * Resolve `@aws-sdk/client-s3` from a directory that actually owns it.
 *
 * This script lives in the repo-root `scripts/` folder, which is not a workspace
 * package and therefore has no `node_modules` link to the SDK. The API image
 * only links the SDK under `packages/db`, so a plain bare import from here
 * fails with ERR_MODULE_NOT_FOUND. Probe the packages that do depend on it.
 */
async function loadAwsSdk() {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const path = await import('node:path');
  const root = path.resolve(import.meta.dirname, '..');
  const candidates = [
    path.join(root, 'packages', 'db', 'package.json'),
    path.join(root, 'apps', 'api', 'package.json'),
    path.join(root, 'package.json'),
  ];
  let lastError;
  for (const candidate of candidates) {
    try {
      const require = createRequire(pathToFileURL(candidate));
      return await import(pathToFileURL(require.resolve('@aws-sdk/client-s3')).href);
    } catch (error) {
      lastError = error;
    }
  }
  // Fall back to a bare import so the error message stays actionable.
  try {
    return await import('@aws-sdk/client-s3');
  } catch {
    throw lastError ?? new Error('无法加载 @aws-sdk/client-s3');
  }
}

const client = new S3Client({
  region: process.env.STORAGE_S3_REGION || 'us-east-1',
  endpoint: required('STORAGE_S3_ENDPOINT'),
  forcePathStyle:
    (process.env.STORAGE_S3_FORCE_PATH_STYLE ?? 'true').toLowerCase() !== 'false',
  credentials: {
    accessKeyId: required('STORAGE_S3_ACCESS_KEY_ID'),
    secretAccessKey: required('STORAGE_S3_SECRET_ACCESS_KEY'),
  },
});
const Bucket = required('STORAGE_S3_BUCKET');

/** Build one ustar header block. */
function makeHeader(name, size, mtimeSeconds, typeFlag = '0') {
  const header = Buffer.alloc(BLOCK, 0);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii'); // mode
  header.write('0000000\0', 108, 8, 'ascii'); // uid
  header.write('0000000\0', 116, 8, 'ascii'); // gid
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write(`${mtimeSeconds.toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii'); // checksum placeholder
  header.write(typeFlag, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

/**
 * Write one regular-file entry. Paths longer than the 100-byte ustar name field
 * are emitted GNU-style: a `././@LongLink` (`L`) header carrying the full path,
 * then the file header with a truncated placeholder name. `tar` and the importer
 * both understand this; a naive utf8 write would silently corrupt the key.
 */
function writeEntry(stream, name, size, mtimeSeconds) {
  if (Buffer.byteLength(name, 'utf8') > 100) {
    const longName = Buffer.from(`${name}\0`, 'utf8');
    stream.write(makeHeader('././@LongLink', longName.length, mtimeSeconds, 'L'));
    stream.write(longName);
    const pad = (BLOCK - (longName.length % BLOCK)) % BLOCK;
    if (pad > 0) stream.write(Buffer.alloc(pad, 0));
  }
  const placeholder = Buffer.from(name, 'utf8').subarray(0, 100).toString('utf8');
  stream.write(makeHeader(placeholder, size, mtimeSeconds));
}

async function exportAll() {
  let token;
  let count = 0;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket, ContinuationToken: token }),
    );
    for (const object of page.Contents ?? []) {
      if (!object.Key) continue;
      if (object.Key.endsWith('/')) continue; // directory marker
      const body = await client.send(new GetObjectCommand({ Bucket, Key: object.Key }));
      if (!body.Body) continue;
      const bytes = Buffer.from(await body.Body.transformToByteArray());
      const mtime = object.LastModified
        ? Math.floor(object.LastModified.getTime() / 1000)
        : Math.floor(Date.now() / 1000);
      writeEntry(process.stdout, object.Key, bytes.length, mtime);
      process.stdout.write(bytes);
      const pad = (BLOCK - (bytes.length % BLOCK)) % BLOCK;
      if (pad > 0) process.stdout.write(Buffer.alloc(pad, 0));
      count += 1;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  process.stdout.write(ZERO_BLOCK);
  process.stdout.write(ZERO_BLOCK);
  process.stderr.write(`==> 已导出 ${count} 个对象\n`);
}

/** Read exactly n bytes from an async iterable buffer list. */
async function* chunks(stream) {
  for await (const chunk of stream) yield chunk;
}

/** Parse a ustar stream and PUT every regular file back into the bucket. */
async function importAll() {
  const buffer = [];
  let buffered = 0;
  let count = 0;

  const take = async (n) => {
    while (buffered < n) {
      const { value, done } = await iterator.next();
      if (done) return null;
      buffer.push(value);
      buffered += value.length;
    }
    const all = Buffer.concat(buffer);
    const head = all.subarray(0, n);
    const rest = all.subarray(n);
    buffer.length = 0;
    if (rest.length > 0) buffer.push(rest);
    buffered = rest.length;
    return Buffer.from(head);
  };

  const iterator = chunks(process.stdin)[Symbol.asyncIterator]();
  /** GNU `L` (long name) / pax `x` (extended header) apply to the next entry. */
  let pendingName = null;

  for (;;) {
    const header = await take(BLOCK);
    if (!header) break;
    if (header.equals(ZERO_BLOCK)) break;
    if (header.length < BLOCK) throw new Error('tar 截断：头部不完整');
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeField = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const typeFlag = header.subarray(156, 157).toString('ascii');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = sizeField ? Number.parseInt(sizeField, 8) : 0;
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`tar 头损坏：${name}`);
    }
    const body = size > 0 ? await take(size) : Buffer.alloc(0);
    if (!body) throw new Error(`tar 截断：${name}`);
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (pad > 0 && !(await take(pad))) throw new Error(`tar 截断：${name}`);

    if (typeFlag === 'L') {
      // GNU long name: the body is the real path of the following member.
      pendingName = body.toString('utf8').replace(/\0.*$/, '');
      continue;
    }
    if (typeFlag === 'x') {
      // pax extended header: look for a `path=` record.
      const text = body.toString('utf8');
      const match = text.match(/(?:^|\n)\d+ path=([^\n]*)/);
      if (match) pendingName = match[1];
      continue;
    }
    if (typeFlag === 'g' || typeFlag === '5') continue; // global pax / directory

    // ustar splits long paths into prefix + name. `tar -C dir .` also emits
    // entries with a leading `./`, which S3 rejects as a "." component.
    const fullName = (pendingName ?? (prefix ? `${prefix}/${name}` : name)).replace(
      /^(\.\/)+/,
      '',
    );
    pendingName = null;
    // Skip macOS AppleDouble metadata (`._name`) and directory entries: they are
    // archive bookkeeping, not user objects, and would pollute the bucket.
    if (!fullName || fullName.endsWith('/')) continue;
    const segments = fullName.split('/');
    if (segments.some((segment) => segment === '.' || segment === '..' || segment === '')) continue;
    if (segments[segments.length - 1].startsWith('._')) continue;
    await client.send(new PutObjectCommand({ Bucket, Key: fullName, Body: body }));
    count += 1;
  }
  process.stderr.write(`==> 已导入 ${count} 个对象\n`);
}

try {
  if (command === 'export') await exportAll();
  else await importAll();
} catch (error) {
  console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
