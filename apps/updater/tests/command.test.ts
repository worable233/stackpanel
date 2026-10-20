import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SpawnCommandRunner, CommandError } from '../src/command.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sp-cmd-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('SpawnCommandRunner', () => {
  it('refuses executables outside the whitelist', async () => {
    const runner = new SpawnCommandRunner(['echo']);
    await expect(runner.run({ file: 'rm', args: ['-rf', '/'] })).rejects.toBeInstanceOf(
      CommandError,
    );
    await expect(runner.run({ file: 'rm', args: [] })).rejects.toThrow(/白名单/);
  });

  it('does not interpret arguments through a shell', async () => {
    const runner = new SpawnCommandRunner(['echo']);
    const result = await runner.run({ file: 'echo', args: ['$(whoami); rm -rf /'] });
    // 参数被原样输出，未被 shell 展开。
    expect(result.stdout.trim()).toBe('$(whoami); rm -rf /');
  });

  it('rejects a non-zero exit unless allowed', async () => {
    const runner = new SpawnCommandRunner(['sh']);
    await expect(runner.run({ file: 'sh', args: ['-c', 'exit 3'] })).rejects.toMatchObject({
      result: { code: 3 },
    });
    const allowed = await runner.run({
      file: 'sh',
      args: ['-c', 'exit 3'],
      allowNonZeroExit: true,
    });
    expect(allowed.code).toBe(3);
  });

  it('streams stdout to a file (binary safe)', async () => {
    const runner = new SpawnCommandRunner(['node']);
    const out = path.join(root, 'dump.bin');
    const result = await runner.run({
      file: 'node',
      args: ['-e', "process.stdout.write(Buffer.from([0, 1, 2, 98, 105, 110, 97, 114, 121]))"],
      stdoutFile: out,
    });
    expect(result.stdout).toBe('');
    const bytes = await readFile(out);
    expect([...bytes.slice(0, 3)]).toEqual([0, 1, 2]);
  });

  it('feeds stdinFile into the child', async () => {
    const runner = new SpawnCommandRunner(['cat']);
    const input = path.join(root, 'in.txt');
    await writeFile(input, 'hello-stdin', 'utf8');
    const result = await runner.run({ file: 'cat', args: [], stdinFile: input });
    expect(result.stdout).toBe('hello-stdin');
  });

  it('kills the child and reports a timeout', async () => {
    const runner = new SpawnCommandRunner(['sleep']);
    await expect(runner.run({ file: 'sleep', args: ['5'], timeoutMs: 50 })).rejects.toMatchObject({
      timedOut: true,
    });
  });
});
