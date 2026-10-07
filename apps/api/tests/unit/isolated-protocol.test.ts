import { describe, expect, it } from 'vitest';
import { decodeWire, encodeWire, wireError } from '../../src/plugins/isolated/protocol.ts';

describe('isolated RPC wire protocol', () => {
  it('round-trips tagged values and structured errors', () => {
    const source = { date: new Date('2026-01-01T00:00:00.000Z'), bytes: Buffer.from('ok'), count: 3n };
    const decoded = decodeWire(encodeWire(source)) as typeof source;
    expect(decoded.date).toEqual(source.date);
    expect(decoded.bytes).toEqual(source.bytes);
    expect(decoded.count).toBe(3n);
    const error = wireError(Object.assign(new Error('bad'), { code: 'x', status: 409, details: { id: 1 } }));
    expect(error).toMatchObject({ message: 'bad', code: 'x', status: 409, details: { id: 1 } });
  });

  it('rejects cyclic values', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => encodeWire(value)).toThrow('circular RPC value');
  });
});
