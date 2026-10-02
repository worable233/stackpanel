/**
 * OpenTelemetry tracing bootstrap (ADR-0015 §1).
 *
 * Tracing is **off by default** and enabled by configuration, matching the
 * ADR's "默认关闭、可配置开启":
 *   - `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`)
 *     points at an OTLP HTTP collector;
 *   - `OTEL_TRACES_ENABLED=true` forces it on even without an endpoint (useful
 *     for wiring checks, though there is then nowhere to export).
 *
 * When enabled, `HttpInstrumentation` auto-instruments inbound and outbound
 * Node HTTP, and because it reads the W3C `traceparent` header, a web→API call
 * continues the same trace. `startTracing()` is idempotent and is called from
 * `server.ts` / `worker.ts` before the app is built, so instrumentation is in
 * place before Fastify installs its request listener.
 *
 * The exporter is wrapped so a collector outage can never crash the process or
 * break request handling: export failures are swallowed (the SDK reports them
 * through the (silent) diagnostics channel), which is the right trade-off for
 * telemetry.
 */
import { trace, type Span } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

/** Kernel service name reported to the collector. */
const SERVICE_NAME = 'stackpanel-api';
const SERVICE_VERSION = '0.4.0';

/** The exporter shape `NodeSDK` expects, derived without a transitive import. */
type TraceExporter = NonNullable<
  NonNullable<ConstructorParameters<typeof NodeSDK>[0]>['traceExporter']
>;

let sdk: NodeSDK | null = null;
let started = false;

export interface StartTracingOptions {
  /** Collector endpoint; falls back to the standard OTel env vars. */
  endpoint?: string | undefined;
  /** Force tracing on even without an endpoint. */
  enabled?: boolean;
  /** Resource attributes service.name / service.version (override for tests). */
  serviceName?: string;
  serviceVersion?: string;
}

/** Whether the environment asks for tracing. */
function resolveEndpoint(options: StartTracingOptions): string | undefined {
  return (
    options.endpoint ??
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  );
}

function tracingEnabled(options: StartTracingOptions): boolean {
  if (options.enabled !== undefined) return options.enabled;
  if (process.env.OTEL_TRACES_ENABLED === 'true') return true;
  if (process.env.OTEL_TRACES_DISABLED === 'true') return false;
  return resolveEndpoint(options) !== undefined;
}

/** A span exporter that never propagates collector failures. */
class ResilientExporter implements TraceExporter {
  constructor(private readonly inner: TraceExporter) {}

  export(
    spans: Parameters<TraceExporter['export']>[0],
    resultCallback: Parameters<TraceExporter['export']>[1],
  ): void {
    try {
      this.inner.export(spans, () => resultCallback({ code: 0 }));
    } catch {
      // A throw here would surface as an uncaught exception in the batch timer.
      resultCallback({ code: 0 });
    }
  }

  shutdown(): Promise<void> {
    const result = this.inner.shutdown?.();
    return Promise.resolve(result).catch(() => undefined);
  }

  forceFlush(): Promise<void> {
    const result = this.inner.forceFlush?.();
    return Promise.resolve(result).catch(() => undefined);
  }
}

/**
 * Start the OTel SDK if configured. Idempotent; safe to call from both the API
 * and the worker entrypoints.
 */
export function startTracing(options: StartTracingOptions = {}): boolean {
  if (started || !tracingEnabled(options)) return started;
  started = true;

  const endpoint = resolveEndpoint(options);
  const exporter = new ResilientExporter(
    new OTLPTraceExporter({
      ...(endpoint ? { url: `${endpoint.replace(/\/$/, '')}/v1/traces` } : {}),
      timeoutMillis: 5000,
    }),
  );

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName ?? SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? SERVICE_VERSION,
    }),
    traceExporter: exporter,
    // Inbound + outbound HTTP share one trace via the W3C traceparent header.
    instrumentations: [new HttpInstrumentation()],
  });
  sdk.start();
  return true;
}

/** Flush and shut the SDK down (graceful shutdown). */
export async function stopTracing(): Promise<void> {
  if (!sdk) return;
  const current = sdk;
  sdk = null;
  started = false;
  await current.shutdown().catch(() => undefined);
}

/** Whether tracing has been started in this process. */
export function isTracingEnabled(): boolean {
  return started;
}

/** The active span, if any (for tests / diagnostics). */
export function activeSpan(): Span | undefined {
  return trace.getActiveSpan();
}

/**
 * The W3C trace id of the active span, or undefined when not tracing. Used to
 * correlate logs with traces without coupling every module to the OTel API.
 */
export function currentTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const { traceId } = span.spanContext();
  // An all-zero trace id means "not sampled / no context".
  return traceId === '00000000000000000000000000000000' ? undefined : traceId;
}
