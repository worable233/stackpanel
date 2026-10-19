import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSafeValue,
  BootstrapFileError,
  bootstrapConfigDigest,
  parseBootstrapFile,
  serializeBootstrapFile,
  writeFileAtomic,
} from '../../src/bootstrap/config-file.ts';

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'sp-bootstrap-file-'));
}

describe('parseBootstrapFile', () => {
  it('parses plain, quoted, exported and commented lines', () => {
    const parsed = parseBootstrapFile(
      [
        '# leading comment',
        'DATABASE_URL="postgresql://u:p@127.0.0.1:5432/db"',
        "REDIS_URL='redis://127.0.0.1:6379'",
        'export STORAGE_DRIVER=s3',
        '  SPACED = " padded "  ',
        '',
        '   ',
      ].join('\n'),
    );
    expect(parsed.get('DATABASE_URL')).toBe('postgresql://u:p@127.0.0.1:5432/db');
    expect(parsed.get('REDIS_URL')).toBe('redis://127.0.0.1:6379');
    expect(parsed.get('STORAGE_DRIVER')).toBe('s3');
    // Quoted values keep their inner spaces; only the quotes are removed.
    expect(parsed.get('SPACED')).toBe(' padded ');
  });

  it('does not treat a trailing # as a comment inside an unquoted value', () => {
    const parsed = parseBootstrapFile('DATABASE_URL=postgresql://u:p#frag@h/db\n');
    expect(parsed.get('DATABASE_URL')).toBe('postgresql://u:p#frag@h/db');
  });

  it('keeps $ and backslashes verbatim (no shell expansion)', () => {
    const parsed = parseBootstrapFile(
      'SECRET="pa$$w0rd\\nraw"\nPLAIN=pa$$w0rd\n',
    );
    expect(parsed.get('SECRET')).toBe('pa$$w0rd\\nraw');
    expect(parsed.get('PLAIN')).toBe('pa$$w0rd');
  });

  it('rejects duplicate keys instead of silently overriding', () => {
    expect(() => parseBootstrapFile('A=1\nA=2\n')).toThrow(BootstrapFileError);
  });

  it('rejects malformed lines and unterminated quotes', () => {
    expect(() => parseBootstrapFile('NOT_A_PAIR\n')).toThrow(BootstrapFileError);
    expect(() => parseBootstrapFile('A="unterminated\n')).toThrow(BootstrapFileError);
    expect(() => parseBootstrapFile('A="x" trailing\n')).toThrow(BootstrapFileError);
  });

  it('tolerates CRLF line endings at the line boundary', () => {
    const parsed = parseBootstrapFile('A="1"\r\nB="2"\r\n');
    expect(parsed.get('A')).toBe('1');
    expect(parsed.get('B')).toBe('2');
  });
});

describe('serializeBootstrapFile', () => {
  it('round-trips values that are easy to get wrong', () => {
    const values = new Map<string, string>([
      ['HASH', 'postgresql://u:p#frag@h/db'],
      ['SPACES', '  leading and trailing  '],
      ['DOLLAR', 'pa$$w0rd'],
      ['BACKSLASH', 'C:\\path\\to\\thing'],
      ['EQUALS', 'a=b=c'],
      ['SINGLE_QUOTE', "it's fine"],
      ['EMPTY', ''],
    ]);
    const parsed = parseBootstrapFile(serializeBootstrapFile(values));
    for (const [key, value] of values) {
      expect(parsed.get(key)).toBe(value);
    }
  });

  it('uses single quotes when the value contains a double quote', () => {
    const text = serializeBootstrapFile(new Map([['K', 'say "hi"']]));
    expect(text).toContain("K='say \"hi\"'");
    expect(parseBootstrapFile(text).get('K')).toBe('say "hi"');
  });

  it('refuses values it cannot represent losslessly', () => {
    expect(() => serializeBootstrapFile(new Map([['K', 'a\'b"c']]))).toThrow(BootstrapFileError);
    expect(() => serializeBootstrapFile(new Map([['K', 'line1\nline2']]))).toThrow(
      BootstrapFileError,
    );
    expect(() => serializeBootstrapFile(new Map([['K', 'nul\0byte']]))).toThrow(BootstrapFileError);
  });
});

describe('assertSafeValue', () => {
  it('accepts the widest realistic DSN characters', () => {
    expect(() =>
      assertSafeValue('DATABASE_URL', 'postgresql://u:p%40ss!@h:5432/db?sslmode=require'),
    ).not.toThrow();
  });

  it('rejects invalid keys, CR/LF, NUL and oversized values', () => {
    expect(() => assertSafeValue('bad key', 'x')).toThrow(BootstrapFileError);
    expect(() => assertSafeValue('K', 'a\rb')).toThrow(BootstrapFileError);
    expect(() => assertSafeValue('K', 'a\0b')).toThrow(BootstrapFileError);
    expect(() => assertSafeValue('K', 'x'.repeat(9000))).toThrow(BootstrapFileError);
  });
});

describe('bootstrapConfigDigest', () => {
  it('is order independent and value sensitive', () => {
    const a = bootstrapConfigDigest([
      ['A', '1'],
      ['B', '2'],
    ]);
    const b = bootstrapConfigDigest([
      ['B', '2'],
      ['A', '1'],
    ]);
    const c = bootstrapConfigDigest([
      ['A', '1'],
      ['B', '3'],
    ]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('writeFileAtomic', () => {
  it('writes the file with the requested mode and survives a rewrite', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'stackpanel.env');
    await writeFileAtomic(file, 'A="1"\n', { mode: 0o640 });
    await writeFileAtomic(file, 'A="2"\n', { mode: 0o640 });
    expect(await readFile(file, 'utf8')).toBe('A="2"\n');
    const { stat, readdir } = await import('node:fs/promises');
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    // No temporary files left behind.
    expect((await readdir(dir)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('creates missing parent directories', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'nested', 'deeper', 'stackpanel.env');
    await writeFileAtomic(file, 'A="1"\n');
    expect(await readFile(file, 'utf8')).toBe('A="1"\n');
  });

  it('leaves the previous file intact when the rename target cannot be replaced', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'stackpanel.env');
    await writeFile(file, 'OLD="1"\n', 'utf8');
    // A directory at the target path makes rename fail; the old file must survive.
    const blocked = path.join(dir, 'blocked');
    await writeFileAtomic(blocked, 'X="1"\n');
    const { mkdir } = await import('node:fs/promises');
    const dirTarget = path.join(dir, 'target');
    await mkdir(dirTarget);
    await expect(writeFileAtomic(dirTarget, 'NEW="1"\n')).rejects.toBeTruthy();
    expect(await readFile(file, 'utf8')).toBe('OLD="1"\n');
  });
});
