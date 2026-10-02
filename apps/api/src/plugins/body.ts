/**
 * Content-type parser routing for raw plugin routes.
 *
 * Fastify's content-type parsers are global, so a raw route cannot opt out of
 * body parsing per request. To let raw routes stream an unparsed body, we
 * replace the built-in JSON parser (and add a `*` fallback) with routing-aware
 * parsers: when a request targets a `kind: 'raw'` plugin route, the raw stream
 * is stashed and handed to the handler untouched; otherwise parsing behaves
 * exactly as before (same body limit, same 400/413/415 outcomes).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import type { MatchResult, PluginDispatcher } from './dispatcher.ts';

const RAW_BODY = Symbol('stackpanel.rawBody');
const DEFAULT_BODY_LIMIT = 1_048_576;

/** The raw, unparsed body stream for a request (falls back to the socket). */
export function rawBodyStream(request: FastifyRequest): Readable {
  const stream = (request as unknown as Record<symbol, unknown>)[RAW_BODY];
  return (stream as Readable | undefined) ?? request.raw;
}

function matchRoute(dispatcher: PluginDispatcher, request: FastifyRequest): MatchResult | null {
  const pathname = request.url.split('?')[0] ?? '';
  return dispatcher.match(request.method, pathname);
}

function stash(request: FastifyRequest, stream: Readable): void {
  (request as unknown as Record<symbol, unknown>)[RAW_BODY] = stream;
}

function codedError(message: string, code: string, statusCode: number): Error {
  const error = new Error(message) as Error & { code: string; statusCode: number };
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

/**
 * Install the routing-aware parsers. Call once, after `@fastify/multipart` is
 * registered (exact parsers keep priority over the `*` fallback) and before the
 * dispatcher catch-all serves requests.
 */
export function installBodyRouting(app: FastifyInstance, dispatcher: PluginDispatcher): void {
  const limitFor = (request: FastifyRequest): number => {
    const route = matchRoute(dispatcher, request)?.route;
    return route?.bodyLimit ?? app.initialConfig?.bodyLimit ?? DEFAULT_BODY_LIMIT;
  };

  // Replace the built-in JSON parser so raw routes can bypass parsing.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', (request, payload, done) => {
    if (matchRoute(dispatcher, request)?.route.kind === 'raw') {
      stash(request, payload);
      done(null, undefined);
      return;
    }
    const bodyLimit = limitFor(request);
    const chunks: Buffer[] = [];
    let size = 0;
    // `payload.destroy()` emits 'error'; guard so `done` runs exactly once.
    let settled = false;
    const finish = (error: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      done(error, value);
    };
    payload.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > bodyLimit) {
        finish(codedError('请求体过大', 'FST_ERR_CTP_BODY_TOO_LARGE', 413));
        payload.destroy();
        return;
      }
      chunks.push(chunk);
    });
    payload.on('error', (error: Error) => finish(error));
    payload.on('end', () => {
      if (settled) return;
      const body = Buffer.concat(chunks).toString('utf8');
      if (body === '') {
        finish(
          codedError(
            "Body cannot be empty when content-type is set to 'application/json'",
            'FST_ERR_CTP_EMPTY_JSON_BODY',
            400,
          ),
        );
        return;
      }
      try {
        finish(null, JSON.parse(body));
      } catch (error) {
        finish(codedError((error as Error).message, 'FST_ERR_CTP_INVALID_JSON', 400));
      }
    });
  });

  // Any other content type: raw routes stream through; otherwise preserve the
  // previous behaviour (415) so adding raw support does not widen the surface.
  app.addContentTypeParser('*', (request, payload, done) => {
    if (matchRoute(dispatcher, request)?.route.kind === 'raw') {
      stash(request, payload);
      done(null, undefined);
      return;
    }
    done(
      codedError(
        `Unsupported Media Type: ${String(request.headers['content-type'] ?? '')}`,
        'FST_ERR_CTP_INVALID_MEDIA_TYPE',
        415,
      ),
    );
  });
}
