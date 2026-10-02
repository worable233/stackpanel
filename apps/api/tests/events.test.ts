import { describe, expect, it, vi } from 'vitest';
import { EventEmitterEventBus } from '../src/plugins/events.ts';

describe('EventEmitterEventBus', () => {
  it('delivers published payloads to subscribers', () => {
    const bus = new EventEmitterEventBus();
    const handler = vi.fn();
    bus.subscribe('user.created', handler);
    bus.publish('user.created', { id: 'u1' });
    expect(handler).toHaveBeenCalledWith({ id: 'u1' });
  });

  it('does not deliver to other topics', () => {
    const bus = new EventEmitterEventBus();
    const handler = vi.fn();
    bus.subscribe('a', handler);
    bus.publish('b', 1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('unsubscribes and stops delivery', () => {
    const bus = new EventEmitterEventBus();
    const handler = vi.fn();
    const unsubscribe = bus.subscribe('t', handler);
    bus.publish('t', 1);
    unsubscribe();
    bus.publish('t', 2);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('supports multiple subscribers', () => {
    const bus = new EventEmitterEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe('t', a);
    bus.subscribe('t', b);
    bus.publish('t', null);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('runs interceptors around next and lets them rewrite the value', () => {
    const bus = new EventEmitterEventBus();
    bus.intercept<number>('price', (value, next) => next(value + 100));
    bus.intercept<number>('price', (value, next) => next(value * 2));
    // Registration order: first interceptor wraps second, so +100 then *2.
    const result = bus.waterfall('price', 10, (value) => value);
    expect(result).toBe(220);
  });

  it('lets an interceptor short-circuit without delegating', () => {
    const bus = new EventEmitterEventBus();
    const downstream = vi.fn((value: number) => value);
    bus.intercept<number>('gate', () => 42);
    bus.intercept<number>('gate', (value, next) => {
      downstream(value);
      return next(value);
    });
    const result = bus.waterfall('gate', 1, (value) => value);
    expect(result).toBe(42);
    expect(downstream).not.toHaveBeenCalled();
  });

  it('throws when an interceptor delegates more than once', () => {
    const bus = new EventEmitterEventBus();
    bus.intercept<number>('twice', (value, next) => {
      next(value);
      return next(value);
    });
    expect(() => bus.waterfall('twice', 1, (value) => value)).toThrow(/multiple times/);
  });

  it('intercept returns an unsubscribe that stops the chain', () => {
    const bus = new EventEmitterEventBus();
    const stop = bus.intercept<number>('p', (value, next) => next(value + 1));
    expect(bus.waterfall('p', 0, (v) => v)).toBe(1);
    stop();
    expect(bus.waterfall('p', 0, (v) => v)).toBe(0);
  });

  it('runs the terminal when no interceptor is registered', () => {
    const bus = new EventEmitterEventBus();
    expect(bus.waterfall('none', 5, (v) => v * 3)).toBe(15);
  });
});
