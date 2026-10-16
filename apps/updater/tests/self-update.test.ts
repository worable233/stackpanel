import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UPDATE_PROTOCOL_VERSION } from '@stackpanel/spec';
import {
  FileHandover,
  FileSelfUpdateState,
  JOURNAL_FORMAT_VERSION,
  assessHandover,
} from '../src/self-update.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sp-selfupdate-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('assessHandover', () => {
  const base = {
    requestedBy: 'host:2',
    protocolVersion: UPDATE_PROTOCOL_VERSION,
    journalFormatVersion: JOURNAL_FORMAT_VERSION,
    requestedAt: '2026-10-17T00:00:00Z',
  };

  it('allows a compatible candidate before it takes over', () => {
    const decision = assessHandover({ request: base, currentOwner: 'host:1' });
    expect(decision.allow).toBe(true);
  });

  it('rejects a protocol mismatch', () => {
    const decision = assessHandover({
      request: { ...base, protocolVersion: UPDATE_PROTOCOL_VERSION + 1 },
      currentOwner: 'host:1',
    });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toMatch(/协议版本不兼容/);
  });

  it('rejects a journal-format mismatch instead of reading an incompatible log', () => {
    const decision = assessHandover({
      request: { ...base, journalFormatVersion: JOURNAL_FORMAT_VERSION + 1 },
      currentOwner: 'host:1',
    });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toMatch(/日志格式不兼容/);
  });

  it('is idempotent for the same writer', () => {
    const decision = assessHandover({ request: base, currentOwner: 'host:2' });
    expect(decision.allow).toBe(true);
    expect(decision.reason).toMatch(/幂等/);
  });
});

describe('FileHandover / FileSelfUpdateState', () => {
  it('round-trips a handover request', async () => {
    const handover = FileHandover.resolve(root);
    expect(await handover.read()).toBeNull();
    await handover.write({
      requestedBy: 'host:2',
      protocolVersion: UPDATE_PROTOCOL_VERSION,
      journalFormatVersion: JOURNAL_FORMAT_VERSION,
      requestedAt: '2026-10-17T00:00:00Z',
    });
    expect((await handover.read())?.requestedBy).toBe('host:2');
    await handover.clear();
    expect(await handover.read()).toBeNull();
  });

  it('records the writer protocol and journal format', async () => {
    const state = FileSelfUpdateState.resolve(root);
    await state.write({
      protocolVersion: UPDATE_PROTOCOL_VERSION,
      journalFormatVersion: JOURNAL_FORMAT_VERSION,
      writerId: 'host:1',
      updatedAt: '2026-10-17T00:00:00Z',
    });
    const read = await state.read();
    expect(read?.journalFormatVersion).toBe(JOURNAL_FORMAT_VERSION);
    expect(read?.writerId).toBe('host:1');
  });
});
