import type { FastifyInstance } from 'fastify';
import type { NotificationView } from '@stackpanel/sdk';
import { currentUser, requireAuth } from '../plugins/auth.ts';
import { getEventBus } from '../plugins/events.ts';
import { getNotificationStreamHub } from '../notifications/stream-hub.ts';

/** Heartbeat interval; keeps intermediaries from reaping an idle stream. */
const HEARTBEAT_MS = 25_000;

/**
 * Live notification stream (SSE).
 *
 * The client keeps one `EventSource` open and receives new/updated
 * notifications as they happen, instead of polling the inbox. Progress of an
 * ongoing activity (status `active`) arrives on the same connection as a
 * `notification.updated` frame, which is what makes the bell show a running
 * progress rather than a 30s-delayed snapshot.
 *
 * Not user-scoped by URL: the session decides the recipient, and the hub filters
 * by that user id, so a stream can never observe another user's notifications.
 */
export async function notificationStreamRoutes(app: FastifyInstance): Promise<void> {
  const hub = getNotificationStreamHub(getEventBus());

  app.get('/notifications/stream', { preHandler: requireAuth }, (request, reply) => {
    const userId = currentUser(request).id;
    const response = reply.raw;
    reply.hijack();

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Defeat proxy buffering (nginx et al.) so frames flush immediately.
      'x-accel-buffering': 'no',
    });
    response.write(': connected\n\n');

    const send = (view: NotificationView): void => {
      if (response.writableEnded) return;
      response.write(`event: notification\ndata: ${JSON.stringify(view)}\n\n`);
    };
    const unsubscribe = hub.subscribe(userId, send);

    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(': ping\n\n');
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.once('close', cleanup);
    response.once('close', cleanup);
  });
}
