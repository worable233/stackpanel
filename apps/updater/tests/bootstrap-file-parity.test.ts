import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseBootstrapFile as parseRunner,
  serializeBootstrapFile as serializeRunner,
} from '../src/artifact/bootstrap-file.ts';
import {
  parseBootstrapFile as parseKernel,
  serializeBootstrapFile as serializeKernel,
} from '../../api/src/bootstrap/config-file.ts';

/**
 * The runner and the kernel each carry an implementation of the bootstrap
 * config format (they are separately published artifacts and cannot share
 * source). This suite is the contract that keeps them identical: every case
 * is run through both and the results must match exactly.
 *
 * If you change one side, this test fails until both are changed.
 */

const PARSE_CASES: string[] = [
  '',
  '\n\n\n',
  '# comment only\n',
  'A=1\n',
  'A="1"\n',
  "A='1'\n",
  'export A=1\n',
  'export A="1"\n',
  '  A  =  1  \n',
  'A="has # hash"\n',
  'A=has#hash\n',
  'A="pa$$w0rd"\n',
  'A=pa$$w0rd\n',
  'A="back\\\\slash"\n',
  'A="quote\\"inside"\n',
  "A='quote\"inside'\n",
  'A=""\n',
  'A=1\r\nB=2\r\n',
  'A=1\n\n# mid\nB=2\n',
  'A=" spaced "\n',
  'DATABASE_URL="postgresql://u:p%40ss@h:5432/db?sslmode=require"\n',
  'A=1\nA=2\n', // duplicate → error on both sides
  'NOT_A_PAIR\n', // invalid line → error
  'A="unterminated\n', // unterminated → error
  'A="x" trailing\n', // trailing junk → error
  'bad key=1\n', // invalid key → error
];

const SERIALIZE_CASES: Array<[string, string]> = [
  ['A', '1'],
  ['A', ''],
  ['A', 'has # hash'],
  ['A', 'pa$$w0rd'],
  ['A', 'back\\slash'],
  ['A', 'C:\\path\\to'],
  ['A', 'a=b=c'],
  ['A', "it's fine"],
  ['A', 'say "hi"'],
  ['A', ' spaced '],
  ['DATABASE_URL', 'postgresql://u:p%40ss@h:5432/db?sslmode=require'],
  // Must be refused identically on both sides.
  ['A', "both ' and \" quotes"],
  ['A', 'newline\nvalue'],
  ['A', 'nul\0value'],
  ['bad key', '1'],
];

describe('bootstrap config file parity', () => {
  it('parses every case identically', () => {
    for (const content of PARSE_CASES) {
      let kernelResult: unknown;
      let runnerResult: unknown;
      try {
        kernelResult = [...parseKernel(content).entries()];
      } catch (error) {
        kernelResult = { error: (error as Error).message };
      }
      try {
        runnerResult = [...parseRunner(content).entries()];
      } catch (error) {
        runnerResult = { error: (error as Error).message };
      }
      expect(runnerResult, `case: ${JSON.stringify(content)}`).toEqual(kernelResult);
    }
  });

  it('serializes every case identically and round-trips both ways', () => {
    for (const [key, value] of SERIALIZE_CASES) {
      let kernelText: string | undefined;
      let runnerText: string | undefined;
      try {
        kernelText = serializeKernel([[key, value]]);
      } catch (error) {
        kernelText = `ERROR:${(error as Error).message}`;
      }
      try {
        runnerText = serializeRunner([[key, value]]);
      } catch (error) {
        runnerText = `ERROR:${(error as Error).message}`;
      }
      expect(runnerText, `case: ${key}`).toBe(kernelText);

      if (!kernelText.startsWith('ERROR:')) {
        // Each side must parse what either side wrote.
        expect([...parseKernel(kernelText).entries()]).toEqual([[key, value]]);
        expect([...parseRunner(kernelText).entries()]).toEqual([[key, value]]);
      }
    }
  });

  it('keeps the generated ecosystem parser honest about the same subset', async () => {
    // The generated ecosystem.config.cjs cannot import either TypeScript module;
    // it carries its own parser. Rather than trusting it, extract and exercise it
    // against the same round-trip expectations.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const scriptPath = path.resolve(here, '../../../scripts/release/build-kernel-artifact.mjs');
    const source = readFileSync(scriptPath, 'utf8');
    expect(source).toContain('function parseEnvFile(file)');

    // The ecosystem parser reads a file; check its treatment of the tricky values
    // by running the generated config in a temp state dir.
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(path.join(tmpdir(), 'sp-eco-parity-'));
    const envFile = path.join(dir, 'stackpanel.env');
    await writeFile(
      envFile,
      serializeKernel([
        ['STACKPANEL_DATA_DIR', '/var/lib/stackpanel/data'],
        ['DATABASE_URL', 'postgresql://u:p#frag@h:5432/db'],
        ['SPACED', '  padded  '],
        ['DOLLAR', 'pa$$w0rd'],
      ]),
      'utf8',
    );

    // Build the ecosystem from the template the way a release would.
    const start = source.indexOf('function ecosystemConfig');
    expect(start).toBeGreaterThan(0);
    const end = source.indexOf('function releaseJson', start);
    const fn = new Function(`${source.slice(start, end)}; return ecosystemConfig;`)() as (input: {
      version: string;
    }) => string;
    const generated = fn({ version: '0.0.0-test' });
    const configPath = path.join(dir, 'ecosystem.config.cjs');
    await writeFile(configPath, generated, 'utf8');

    process.env['STACKPANEL_STATE_DIR'] = dir;
    try {
      const loaded = (await import(`${configPath}?v=${Date.now()}`)) as {
        default?: { apps: Array<{ name: string; env: Record<string, string> }> };
        apps?: Array<{ name: string; env: Record<string, string> }>;
      };
      const apps = loaded.default?.apps ?? loaded.apps ?? [];
      const api = apps.find((app) => app.name === 'stackpanel-api');
      expect(api?.env['DATABASE_URL']).toBe('postgresql://u:p#frag@h:5432/db');
      expect(api?.env['SPACED']).toBe('  padded  ');
      expect(api?.env['DOLLAR']).toBe('pa$$w0rd');
    } finally {
      delete process.env['STACKPANEL_STATE_DIR'];
    }
  });
});
