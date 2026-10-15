/**
 * Every PostHog import in the kit, loaded by `telemetry-sdk.ts` only once all
 * three of the settings that turn exception reporting on are given.
 *
 * PostHog's error tracking groups `$exception` events, which OTLP traces and
 * logs do not produce, so a failed run's error is sent to it separately, as
 * Marfa's server sends its own.
 */
import { PostHog } from "posthog-node";
import { reportableError } from "./exception-text.js";
import {
  exportTimeoutMs,
  telemetryBoundMs,
  type ExceptionSettings,
} from "./telemetry.js";

/** The deepest an event nests a value: a frame is four levels down. */
const maxDepth = 12;

function redactedDeep(
  value: unknown,
  redact: (text: string) => string,
  depth = 0,
): unknown {
  if (typeof value === "string") return redact(value);
  if (depth >= maxDepth) {
    // What cannot be read whole is not sent.
    throw new Error("an event nests deeper than it can be redacted");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactedDeep(entry, redact, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactedDeep(entry, redact, depth + 1),
      ]),
    );
  }
  return value;
}

export interface ExceptionReporter {
  /** Queues one `$exception` event for `error`. */
  report(error: unknown, properties: Record<string, string>): void;
  /** Sends what waits, giving up after {@link telemetryBoundMs}. */
  shutdown(): Promise<void>;
}

/**
 * One send, held to the same bound as an OTLP export. The SDK writes any
 * failed send to the console, with its stack, beside the connector's own log
 * lines. So the failure is told to `failed` here, which warns once through the
 * log, and the SDK is answered as if the send had landed: it has nothing to
 * retry, since the retry count is zero, and nothing to say.
 */
function sendWith(failed: (error: Error | undefined) => void) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.any([
          ...(init.signal ? [init.signal] : []),
          AbortSignal.timeout(exportTimeoutMs),
        ]),
      });
      if (response.ok) return response;
      failed(new Error(`PostHog answered ${String(response.status)}`));
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      failed(error instanceof Error ? error : undefined);
    }
    return new Response(null, { status: 200 });
  };
}

/**
 * Each event is redacted as it is sent, with every secret the log knows by
 * then, and an event that cannot be redacted is dropped. A failed send is
 * reported through `failed`, and never fails a run.
 */
export function reporting(
  settings: ExceptionSettings,
  redact: (text: string) => string,
  failed: (error: Error | undefined) => void,
): ExceptionReporter {
  const client = new PostHog(settings.token, {
    host: settings.host,
    // The address an event arrives from is the connector's own, so a
    // location looked up from it describes the host, not a person.
    disableGeoip: true,
    // A failed run is rare and worth sending at once, not after a batch.
    flushAt: 1,
    // Bounded as the OTLP exports are: no retry, and a request that is not
    // answered in time, connecting included, is dropped by `sendWith`, which
    // the SDK's own, longer, deadline never beats.
    fetch: sendWith(failed),
    requestTimeout: exportTimeoutMs + 500,
    fetchRetryCount: 0,
    before_send: (event) =>
      event === null
        ? null
        : {
            ...event,
            properties: redactedDeep(event.properties, redact) as Record<
              string,
              unknown
            >,
          },
  });
  return {
    report(error, properties) {
      // No distinct id: the event is the connector's, and the client then
      // sends it without creating a person.
      client.captureException(reportableError(error, redact), undefined, {
        ...properties,
      });
    },
    async shutdown() {
      await client.shutdown(telemetryBoundMs);
    },
  };
}
