/**
 * Every OpenTelemetry import in the kit, loaded by `telemetry.ts` only once
 * the settings turn telemetry on.
 */
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type AttributeValue,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { SeverityNumber, type AnyValue } from "@opentelemetry/api-logs";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Level, Logger } from "./log.js";
import { describe, type RunResult, type Trigger } from "./run.js";
import type { ExceptionReporter } from "./telemetry-posthog.js";
import type { Clock } from "./runtime.js";
import {
  exportTimeoutMs,
  telemetryBoundMs,
  type Telemetry,
  type TelemetrySettings,
} from "./telemetry.js";

type Redact = (text: string) => string;

const severity: Record<Level, SeverityNumber> = {
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

function redactValue(value: AttributeValue, redact: Redact): AttributeValue {
  if (typeof value === "string") return redact(value);
  if (!Array.isArray(value)) return value;
  return value.map((entry: unknown) =>
    typeof entry === "string" ? redact(entry) : entry,
  ) as AttributeValue;
}

function redactAttributes(attributes: Attributes, redact: Redact): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    out[key] = value === undefined ? value : redactValue(value, redact);
  }
  return out;
}

function redactAny(value: AnyValue, redact: Redact): AnyValue {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value))
    return value.map((entry) => redactAny(entry, redact));
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Uint8Array) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      redactAny(entry, redact),
    ]),
  );
}

function redactSpan(span: ReadableSpan, redact: Redact): ReadableSpan {
  const { status } = span;
  return {
    name: redact(span.name),
    kind: span.kind,
    spanContext: () => span.spanContext(),
    ...(span.parentSpanContext !== undefined && {
      parentSpanContext: span.parentSpanContext,
    }),
    startTime: span.startTime,
    endTime: span.endTime,
    status:
      status.message === undefined
        ? status
        : { ...status, message: redact(status.message) },
    attributes: redactAttributes(span.attributes, redact),
    links: span.links.map((link) =>
      link.attributes === undefined
        ? link
        : { ...link, attributes: redactAttributes(link.attributes, redact) },
    ),
    events: span.events.map((event) => ({
      ...event,
      name: redact(event.name),
      ...(event.attributes !== undefined && {
        attributes: redactAttributes(event.attributes, redact),
      }),
    })),
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/** A record's fields are getters on its class, which a spread leaves out,
 *  so each is copied by name. */
function redactLogRecord(
  record: ReadableLogRecord,
  redact: Redact,
): ReadableLogRecord {
  return {
    hrTime: record.hrTime,
    hrTimeObserved: record.hrTimeObserved,
    ...(record.spanContext !== undefined && {
      spanContext: record.spanContext,
    }),
    ...(record.severityText !== undefined && {
      severityText: redact(record.severityText),
    }),
    ...(record.severityNumber !== undefined && {
      severityNumber: record.severityNumber,
    }),
    ...(record.body !== undefined && { body: redactAny(record.body, redact) }),
    ...(record.eventName !== undefined && {
      eventName: redact(record.eventName),
    }),
    resource: record.resource,
    instrumentationScope: record.instrumentationScope,
    attributes: redactAny(
      record.attributes,
      redact,
    ) as typeof record.attributes,
    droppedAttributesCount: record.droppedAttributesCount,
  };
}

/**
 * The one place telemetry leaves the process. Each record is redacted here,
 * as it is sent, with every secret the log knows by then, so a secret kept
 * after a record was made is redacted from it too. A failed export is
 * warned of once in the process's life, and never fails a run.
 */
class Redacting<T> {
  constructor(
    private readonly inner: {
      export(items: T[], done: (result: ExportResult) => void): void;
      shutdown(): Promise<void>;
      forceFlush?(): Promise<void>;
    },
    private readonly redact: (item: T) => T,
    private readonly failed: (error: Error | undefined) => void,
  ) {}

  export(items: T[], done: (result: ExportResult) => void): void {
    let redacted: T[];
    try {
      redacted = items.map((item) => this.redact(item));
    } catch (error) {
      // Nothing unredacted is sent: the batch is dropped instead.
      const failure = error instanceof Error ? error : new Error(String(error));
      this.failed(failure);
      done({ code: ExportResultCode.FAILED, error: failure });
      return;
    }
    this.inner.export(redacted, (result) => {
      if (result.code !== ExportResultCode.SUCCESS) this.failed(result.error);
      done(result);
    });
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

/**
 * Exports a trace for a failed run whatever the ratio, and a succeeded or
 * stopped one at the ratio. A run's trace is its one span, so deciding on
 * the span decides the trace.
 */
class Sampled implements SpanProcessor {
  constructor(
    private readonly inner: SpanProcessor,
    private readonly ratio: number,
    private readonly random: () => number,
  ) {}

  onStart(span: Parameters<SpanProcessor["onStart"]>[0], context: Context) {
    this.inner.onStart(span, context);
  }

  onEnd(span: ReadableSpan): void {
    if (span.status.code === SpanStatusCode.ERROR || this.random() < this.ratio)
      this.inner.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

function outcomeOf(result: RunResult): string {
  if (result.succeeded) return "succeeded";
  return result.failure === undefined ? "stopped" : "failed";
}

export async function exporting(
  settings: TelemetrySettings,
  connectorName: string,
  logger: Logger,
  clock: Clock,
  random: () => number,
): Promise<Telemetry> {
  const redact: Redact = (text) => logger.redact(text);
  let warned = false;
  const failed = (error: Error | undefined): void => {
    if (warned) return;
    warned = true;
    logger.warn(
      `telemetry could not be sent, and the connector goes on without what was lost; this is said once: ${error === undefined ? "no reason was given" : describe(error)}`,
    );
  };
  let exceptions: ExceptionReporter | undefined;
  if (settings.exceptions !== undefined) {
    try {
      // The only place PostHog's code is loaded, and only once all three of
      // its settings are given. Without it the OTLP exports go on.
      const posthog = await import("./telemetry-posthog.js");
      exceptions = posthog.reporting(settings.exceptions, redact, failed);
    } catch (error) {
      logger.warn(
        `exceptions could not be sent to PostHog, so the connector goes on without them: ${describe(error)}`,
      );
    }
  }
  const resource = resourceFromAttributes({
    "service.name": settings.serviceName ?? connectorName,
    "marfa.connector.name": connectorName,
    // As the server labels its own.
    "deployment.environment": "production",
  });
  const bounded = {
    exportTimeoutMillis: exportTimeoutMs,
  };
  const tracerProvider = new BasicTracerProvider({
    resource,
    sampler: new AlwaysOnSampler(),
    spanProcessors: [
      new Sampled(
        new BatchSpanProcessor(
          new Redacting<ReadableSpan>(
            new OTLPTraceExporter({
              url: settings.tracesEndpoint,
              headers: { ...settings.tracesHeaders },
              timeoutMillis: exportTimeoutMs,
              // The request timeout starts only once the socket connects; the
              // socket timeout also bounds a connect that never completes.
              httpAgentOptions: { timeout: exportTimeoutMs },
            }),
            (span) => redactSpan(span, redact),
            failed,
          ),
          bounded,
        ),
        settings.sampleRatio,
        random,
      ),
    ],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor({
        exporter: new Redacting<ReadableLogRecord>(
          new OTLPLogExporter({
            url: settings.logsEndpoint,
            headers: { ...settings.logsHeaders },
            timeoutMillis: exportTimeoutMs,
            // The request timeout starts only once the socket connects; the
            // socket timeout also bounds a connect that never completes.
            httpAgentOptions: { timeout: exportTimeoutMs },
          }),
          (record) => redactLogRecord(record, redact),
          failed,
        ) satisfies LogRecordExporter,
        ...bounded,
      }),
    ],
  });
  const tracer = tracerProvider.getTracer("@withmarfa/connector");
  const ended = (
    span: Span,
    result: RunResult | undefined,
    thrown: unknown,
  ): void => {
    const at = clock.now();
    span.setAttribute(
      "marfa.connector.outcome",
      result === undefined ? "failed" : outcomeOf(result),
    );
    // A run that threw failed as surely as one that reported a failure.
    if (result === undefined || result.failure !== undefined) {
      const failure = result === undefined ? thrown : result.failure;
      span.recordException(
        failure instanceof Error ? failure : String(failure),
        at,
      );
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: describe(failure),
      });
    }
    span.end(at);
  };
  // Not sampled: the ratio is for traces, and a failed run's error is always
  // sent, whether or not its span could be made.
  const reported = (
    result: RunResult | undefined,
    thrown: unknown,
    trigger: Trigger,
  ): void => {
    if (result !== undefined && result.failure === undefined) return;
    try {
      exceptions?.report(result === undefined ? thrown : result.failure, {
        "service.name": settings.serviceName ?? connectorName,
        "marfa.connector.name": connectorName,
        "marfa.connector.trigger": trigger,
        "deployment.environment": "production",
      });
    } catch {
      // A report that cannot be made is lost to error tracking alone.
    }
  };
  const emitter = loggerProvider.getLogger("@withmarfa/connector");
  let current: Span | undefined;

  logger.tee((level, message, at) => {
    try {
      emitter.emit({
        timestamp: at,
        severityNumber: severity[level],
        severityText: level.toUpperCase(),
        body: message,
        ...(current !== undefined && {
          context: trace.setSpan(ROOT_CONTEXT, current),
        }),
      });
    } catch {
      // A line the SDK will not take is lost to telemetry alone.
    }
  });

  return {
    async run(trigger: Trigger, work: () => Promise<RunResult>) {
      let span: Span | undefined;
      try {
        span = tracer.startSpan(
          "connector run",
          {
            kind: SpanKind.INTERNAL,
            startTime: clock.now(),
            attributes: { "marfa.connector.trigger": trigger },
          },
          ROOT_CONTEXT,
        );
      } catch {
        // The run goes on without its trace.
      }
      current = span;
      let result: RunResult | undefined;
      let thrown: unknown;
      try {
        result = await work();
        return result;
      } catch (error) {
        thrown = error;
        throw error;
      } finally {
        current = undefined;
        try {
          if (span !== undefined) ended(span, result, thrown);
        } catch {
          // Telemetry never changes how a run ends.
        }
        reported(result, thrown, trigger);
      }
    },

    async shutdown() {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([
          tracerProvider.shutdown(),
          loggerProvider.shutdown(),
          exceptions?.shutdown(),
        ]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, telemetryBoundMs);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
    },
  };
}
