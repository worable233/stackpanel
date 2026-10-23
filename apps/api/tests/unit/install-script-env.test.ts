import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseBootstrapFile } from '../../src/bootstrap/config-file.ts';

const run = promisify(execFile);

/**
 * The installer generates `stackpanel.env` with an inline Node script (it runs
 * on hosts without the kernel's TypeScript sources). That script is a fourth
 * implementation of the same file format, next to the kernel, the runner and
 * the generated PM2 ecosystem. These tests extract it from the shell script and
 * check it against the kernel parser — otherwise a change in one place silently
 * produces a file the API cannot read, which manifests as "installer succeeded
 * but the instance will not boot".
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, '../../../../scripts/install-artifact.sh');

async function extractNodeWriter(): Promise<string> {
  const source = await readFile(scriptPath, 'utf8');
  const start = source.indexOf('node - "${ENV_FILE}"');
  expect(start).toBeGreaterThan(0);
  const bodyStart = source.indexOf("<<'NODE'\n", start) + "<<'NODE'\n".length;
  const bodyEnd = source.indexOf('\nNODE\n', bodyStart);
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  return source.slice(bodyStart, bodyEnd);
}

async function writeEnv(
  dir: string,
  input: {
    dataDir: string;
    stateDir: string;
    jwt: string;
    encKey: string;
    token: string;
    siteUrl: string;
    existing?: string;
  },
): Promise<string> {
  const writer = path.join(dir, 'writer.cjs');
  await writeFile(writer, await extractNodeWriter(), 'utf8');
  const envFile = path.join(dir, 'stackpanel.env');
  if (input.existing !== undefined) await writeFile(envFile, input.existing, 'utf8');

  await run(process.execPath, [
    writer,
    envFile,
    input.dataDir,
    input.stateDir,
    input.jwt,
    input.encKey,
    input.token,
    input.siteUrl,
  ]);
  return envFile;
}

describe('install-artifact env writer', () => {
  it('writes a file the kernel parser reads back exactly', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sp-install-env-'));
    const envFile = await writeEnv(dir, {
      dataDir: '/var/lib/stackpanel/data',
      stateDir: '/var/lib/stackpanel',
      jwt: 'jwt-with-#-hash',
      encKey: 'a2V5+/=base64',
      token: 'tok$with$dollars',
      siteUrl: 'https://panel.example.com',
    });

    const parsed = parseBootstrapFile(await readFile(envFile, 'utf8'));
    expect(parsed.get('STACKPANEL_DATA_DIR')).toBe('/var/lib/stackpanel/data');
    expect(parsed.get('STACKPANEL_STATE_DIR')).toBe('/var/lib/stackpanel');
    expect(parsed.get('JWT_SECRET')).toBe('jwt-with-#-hash');
    expect(parsed.get('SETTINGS_ENCRYPTION_KEY')).toBe('a2V5+/=base64');
    expect(parsed.get('STACKPANEL_SETUP_TOKEN')).toBe('tok$with$dollars');
    expect(parsed.get('SITE_URL')).toBe('https://panel.example.com');
    expect(parsed.get('NODE_ENV')).toBe('production');

    // Owner-read/write only: the file holds the JWT secret and claim token.
    expect((await stat(envFile)).mode & 0o777).toBe(0o640);
  });

  it('preserves installer-owned and operator-added keys across a re-run', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sp-install-env-keep-'));
    const existing = [
      'STACKPANEL_DATA_DIR="/srv/data"',
      'JWT_SECRET="old-jwt"',
      'SETTINGS_ENCRYPTION_KEY="old-key"',
      'STACKPANEL_SETUP_TOKEN="old-token"',
      'SMTP_URL="smtp://user:pa#ss@mail:587"',
      'UNRELATED="keep me"',
      '',
    ].join('\n');

    const envFile = await writeEnv(dir, {
      dataDir: '/srv/data',
      stateDir: '/srv/state',
      // The installer passes through the values it read, which must equal the
      // existing ones; this is exactly the "do not regenerate" path.
      jwt: 'old-jwt',
      encKey: 'old-key',
      token: 'old-token',
      siteUrl: '',
      existing,
    });

    const parsed = parseBootstrapFile(await readFile(envFile, 'utf8'));
    expect(parsed.get('JWT_SECRET')).toBe('old-jwt');
    expect(parsed.get('SETTINGS_ENCRYPTION_KEY')).toBe('old-key');
    expect(parsed.get('STACKPANEL_SETUP_TOKEN')).toBe('old-token');
    // Operator-added keys survive; a '#' inside a value is not a comment.
    expect(parsed.get('SMTP_URL')).toBe('smtp://user:pa#ss@mail:587');
    expect(parsed.get('UNRELATED')).toBe('keep me');
    // An empty --site-url must not wipe an existing SITE_URL; here none existed,
    // so the key is simply absent rather than set to "".
    expect(parsed.has('SITE_URL')).toBe(false);
  });

  it('does not overwrite an operator-set API_BASE_URL', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sp-install-env-api-'));
    const envFile = await writeEnv(dir, {
      dataDir: '/d',
      stateDir: '/s',
      jwt: 'j',
      encKey: 'e',
      token: 't',
      siteUrl: '',
      existing: 'API_BASE_URL="http://internal:9001"\n',
    });
    expect(parseBootstrapFile(await readFile(envFile, 'utf8')).get('API_BASE_URL')).toBe(
      'http://internal:9001',
    );
  });
});

describe('install-artifact read_env_value', () => {
  async function readValue(file: string, key: string): Promise<string> {
    const source = await readFile(scriptPath, 'utf8');
    const start = source.indexOf('read_env_value() {');
    expect(start).toBeGreaterThan(0);
    const end = source.indexOf('\n}\n', start) + 2;
    const script = `${source.slice(start, end)}\nread_env_value "$1" "$2"\n`;
    const scriptFile = path.join(path.dirname(file), 'read-env.sh');
    await writeFile(scriptFile, script, 'utf8');
    const { stdout } = await run('bash', [scriptFile, key, file]);
    return stdout;
  }

  it('reads quoted, single-quoted, exported and unquoted values', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sp-read-env-'));
    const file = path.join(dir, 'stackpanel.env');
    await writeFile(
      file,
      [
        '# comment',
        'A="double"',
        "B='single'",
        'export C=exported',
        'D=plain',
        'E="with # hash"',
        'F="pa$$w0rd"',
        '',
      ].join('\n'),
      'utf8',
    );
    expect(await readValue(file, 'A')).toBe('double');
    expect(await readValue(file, 'B')).toBe('single');
    expect(await readValue(file, 'C')).toBe('exported');
    expect(await readValue(file, 'D')).toBe('plain');
    expect(await readValue(file, 'E')).toBe('with # hash');
    expect(await readValue(file, 'F')).toBe('pa$$w0rd');
    // Missing key and missing file both resolve to the empty string, which the
    // installer treats as "generate a new secret".
    expect(await readValue(file, 'MISSING')).toBe('');
    expect(await readValue(path.join(dir, 'nope.env'), 'A')).toBe('');
  });

  it('does not let a value that looks like a key shadow the real one', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sp-read-env-shadow-'));
    const file = path.join(dir, 'stackpanel.env');
    await writeFile(file, 'NOTE="JWT_SECRET=fake"\nJWT_SECRET="real"\n', 'utf8');
    expect(await readValue(file, 'JWT_SECRET')).toBe('real');
  });
});
