import { describe, expect, it } from 'vitest';
import { createTextSink } from '../../src/agent/actions.ts';

/**
 * Sandbox stdout/stderr arrive as arbitrary `Buffer` chunks that can split a
 * multi-byte character. Decoding each chunk independently turns both halves
 * into U+FFFD, so the run record no longer matches what the container printed.
 */
describe('sandbox output decoding', () => {
  it('reassembles characters split across chunk boundaries', () => {
    const text = '隔离动作输出：日本語テスト';
    const bytes = Buffer.from(text, 'utf8');
    const sink = createTextSink(1024);
    // One byte at a time is the worst case: every multi-byte character is split.
    for (let i = 0; i < bytes.length; i += 1) expect(sink.push(bytes.subarray(i, i + 1))).toBe(true);
    expect(sink.finish()).toBe(text);
    expect(sink.finish()).not.toContain('\uFFFD');
  });

  it('does not count decoded length against the byte budget', () => {
    const sink = createTextSink(8);
    // '中' is 3 bytes but 1 code unit; the budget is on bytes.
    expect(sink.push(Buffer.from('中中', 'utf8'))).toBe(true);
    expect(sink.push(Buffer.from('中', 'utf8'))).toBe(false);
    expect(sink.finish()).toBe('中中');
  });

  it('emits a single replacement character when the stream truly ends mid-character', () => {
    const sink = createTextSink(1024);
    sink.push(Buffer.from('尾', 'utf8').subarray(0, 2));
    // The stream is genuinely truncated, so exactly one U+FFFD is correct —
    // what must not happen is one replacement character per chunk.
    expect(sink.finish()).toBe('\ufffd');
  });
});
