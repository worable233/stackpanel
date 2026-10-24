import { describe, expect, it } from 'vitest';
import { isPluginError, isWalletError, sdkErrorClassName, WalletError } from '@stackpanel/sdk';
import {
  decodeWire,
  encodeWire,
  parseTransactionCapability,
  reviveWireError,
  wireError,
} from '../../src/plugins/isolated/protocol.ts';

describe('isolated RPC wire protocol', () => {
  it('round-trips tagged values and structured errors', () => {
    const source = {
      date: new Date('2026-01-01T00:00:00.000Z'),
      bytes: Buffer.from('ok'),
      count: 3n,
    };
    const decoded = decodeWire(encodeWire(source)) as typeof source;
    expect(decoded.date).toEqual(source.date);
    expect(decoded.bytes).toEqual(source.bytes);
    expect(decoded.count).toBe(3n);
    const error = wireError(
      Object.assign(new Error('bad'), { code: 'x', status: 409, details: { id: 1 } }),
    );
    expect(error).toMatchObject({ message: 'bad', code: 'x', status: 409, details: { id: 1 } });
  });

  it('rejects cyclic values', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(() => encodeWire(value)).toThrow('circular RPC value');
  });

  describe('parseTransactionCapability', () => {
    it('routes transactional extension calls to the extensions handler', () => {
      // Regression: `tx.extensions.create` used to match the generic
      // `tx.<group>.<op>` pattern, so it entered the wallet/payments branch and
      // failed with "未知事务操作：extensions.create". Isolated plugins could not
      // write custom-model rows inside a transaction at all.
      expect(parseTransactionCapability('tx.extensions.create')).toBeNull();
      expect(parseTransactionCapability('tx.extensions.get')).toBeNull();
      expect(parseTransactionCapability('tx.extensions.updateWhere')).toBeNull();
    });

    it('still parses real transactional capabilities', () => {
      expect(parseTransactionCapability('tx.wallet.debit')).toEqual({
        group: 'wallet',
        operation: 'debit',
      });
      expect(parseTransactionCapability('tx.wallet.settleHold')).toEqual({
        group: 'wallet',
        operation: 'settleHold',
      });
      expect(parseTransactionCapability('tx.payments.createRecord')).toEqual({
        group: 'payments',
        operation: 'createRecord',
      });
      expect(parseTransactionCapability('tx.events.publish')).toEqual({
        group: 'events',
        operation: 'publish',
      });
    });

    it('returns null for unrelated capabilities', () => {
      for (const capability of [
        'extensions.create',
        'tx.commit',
        'tx.begin',
        'wallet.debit',
        'tx.wallet',
        '',
      ]) {
        expect(parseTransactionCapability(capability)).toBeNull();
      }
    });
  });

  describe('reviveWireError', () => {
    it('rebuilds a branded PluginError so the kernel keeps the plugin status', () => {
      // Regression: the host used to wrap wire errors in a bare `Error`, which
      // dropped the SDK brand. `isPluginError` then failed and every plugin 4xx
      // (403/404) surfaced as a 500.
      const revived = reviveWireError(
        wireError(
          Object.assign(new Error('无权访问该工单'), {
            code: 'ticket.forbidden',
            status: 403,
          }),
        ),
      );
      expect(isPluginError(revived)).toBe(true);
      expect(revived).toMatchObject({
        code: 'ticket.forbidden',
        status: 403,
        detail: '无权访问该工单',
      });
      expect(revived.message).toBe('无权访问该工单');
      expect((revived as Error & { statusCode?: number }).statusCode).toBe(403);
    });

    it('keeps an error without code+status as an internal fault', () => {
      const revived = reviveWireError({ message: 'boom' });
      expect(isPluginError(revived)).toBe(false);
      expect(revived.message).toBe('boom');
    });

    it('does not brand errors that only carry a status', () => {
      const revived = reviveWireError({ message: 'partial', status: 500 });
      expect(isPluginError(revived)).toBe(false);
      expect((revived as Error & { status?: number }).status).toBe(500);
    });

    it('restores the SDK error class brand across the boundary', () => {
      // Regression: the brand lives on the SDK class prototype and is
      // non-enumerable, so JSON dropped it. An isolated plugin's
      // `catch (e) { if (isWalletError(e)) … }` then took the generic branch —
      // referral treated an `insufficient_balance` debit as a hard failure
      // instead of clawing back 0, so a refund silently never settled.
      const wire = wireError(new WalletError(409, 'insufficient_balance'));
      expect(wire.sdkError).toBe('WalletError');
      const revived = reviveWireError(wire);
      expect(sdkErrorClassName(revived)).toBe('WalletError');
      expect(isWalletError(revived)).toBe(true);
    });

    it('keeps a plain error unbranded on the wire', () => {
      expect(wireError(new Error('boom')).sdkError).toBeUndefined();
      expect(sdkErrorClassName(new Error('boom'))).toBeUndefined();
    });
  });
});
