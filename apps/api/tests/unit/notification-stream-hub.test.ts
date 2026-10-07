import { describe, expect, it } from 'vitest';
import type { NotificationView } from '@stackpanel/sdk';
import { EventEmitterEventBus } from '../../src/plugins/events.ts';
import { NotificationStreamHub } from '../../src/notifications/stream-hub.ts';

function view(id: string, overrides: Partial<NotificationView> = {}): NotificationView {
  return {
    id,
    type: 'system.frontend-apply',
    title: '安装中',
    body: null,
    link: null,
    data: null,
    status: 'active',
    progress: 10,
    readAt: null,
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:00.000Z',
    ...overrides,
  };
}

describe('NotificationStreamHub', () => {
  it('delivers created/updated events to the matching user only', () => {
    const events = new EventEmitterEventBus();
    const hub = new NotificationStreamHub(events);
    hub.start();

    const received: NotificationView[] = [];
    hub.subscribe('user-1', (item) => received.push(item));

    events.publish('notification.created', { notification: view('a'), userId: 'user-1' });
    events.publish('notification.updated', {
      notification: view('a', { progress: 50 }),
      userId: 'user-1',
    });
    // Another user's event must not reach user-1.
    events.publish('notification.created', { notification: view('b'), userId: 'user-2' });

    expect(received.map((item) => item.id)).toEqual(['a', 'a']);
    expect(received[1]?.progress).toBe(50);
  });

  it('stops delivering after unsubscribe', () => {
    const events = new EventEmitterEventBus();
    const hub = new NotificationStreamHub(events);
    hub.start();

    let count = 0;
    const off = hub.subscribe('user-1', () => (count += 1));
    events.publish('notification.created', { notification: view('a'), userId: 'user-1' });
    off();
    events.publish('notification.created', { notification: view('a'), userId: 'user-1' });

    expect(count).toBe(1);
    expect(hub.connectionCount).toBe(0);
  });

  it('isolates a throwing sink from its siblings', () => {
    const events = new EventEmitterEventBus();
    const hub = new NotificationStreamHub(events);
    hub.start();

    let ok = 0;
    hub.subscribe('user-1', () => {
      throw new Error('broken pipe');
    });
    hub.subscribe('user-1', () => (ok += 1));

    expect(() =>
      events.publish('notification.created', { notification: view('a'), userId: 'user-1' }),
    ).not.toThrow();
    expect(ok).toBe(1);
  });

  it('ignores an event without a routing userId', () => {
    const events = new EventEmitterEventBus();
    const hub = new NotificationStreamHub(events);
    hub.start();

    let count = 0;
    hub.subscribe('user-1', () => (count += 1));
    events.publish('notification.created', { notification: view('a'), userId: '' });
    expect(count).toBe(0);
  });
});
