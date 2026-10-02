/**
 * Sales-channel contract (Halo-aligned).
 *
 * A sales channel groups a terminal (PC / mini-program / API) with the payment
 * methods it offers, and records the order's origin for tracking. Clients pass
 * a `channelCode` at checkout (default `MALL_PC`) instead of a free-form
 * `providerId`; the kernel resolves the channel's enabled, currency-compatible
 * methods.
 */

/** Terminal a channel targets. */
export type ChannelTerminal = 'PC' | 'MINI_PROGRAM' | 'API';

/** A configured payment method instance bound to a channel. */
export interface PaymentMethodInstance {
  id: string;
  channelId: string;
  /** Provider extension id, e.g. `epay` | `bank_transfer` | `qrcode`. */
  providerId: string;
  name: string;
  enabled: boolean;
  scene: string;
  sortOrder: number;
}

/** A sales channel with its bound methods. */
export interface SalesChannel {
  id: string;
  code: string;
  name: string;
  terminal: ChannelTerminal;
  enabled: boolean;
  sortOrder: number;
  methods: PaymentMethodInstance[];
}
