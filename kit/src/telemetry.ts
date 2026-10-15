import { ConfigurationError, shortestSecret } from "./environment.js";
import type { Logger } from "./log.js";
import type { RunResult, Trigger } from "./run.js";
import type { Clock } from "./runtime.js";

/** The longest one export may take, retries included. An export that runs
 *  out of it is dropped. */
export const exportTimeoutMs = 1500;

/** The longest telemetry holds up the end of a process: an export already
 *  under way, then the last one. */
export const telemetryBoundMs = 2 * exportTimeoutMs;

/**
 * The settings, read as Marfa's server reads them: present only when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set, which is what turns telemetry on.
 */
export interface ExceptionSettings {
  readonly host: string;
  /** The PostHog project token, which is a secret. */
  readonly token: string;
}

export interface TelemetrySettings {
  readonly serviceName: string | undefined;
  readonly tracesEndpoint: string;
  readonly logsEndpoint: string;
  readonly tracesHeaders: Readonly<Record<string, string>>;
  readonly logsHeaders: Readonly<Record<string, string>>;
  /** The share of succeeded runs whose trace is exported. */
  readonly sampleRatio: number;
  /** Where a failed run's error is sent for PostHog's error tracking, when
   *  both of its settings are given. */
  readonly exceptions: ExceptionSettings | undefined;
}

export interface Telemetry {
  /** Does the run inside a trace of its own, which records how it ended. */
  run(trigger: Trigger, work: () => Promise<RunResult>): Promise<RunResult>;
  /** Sends what waits, giving up after {@link telemetryBoundMs}. */
  shutdown(): Promise<void>;
}

/** Off: nothing is loaded, and a run is only the run. */
export const noTelemetry: Telemetry = {
  run: (_trigger, work) => work(),
  shutdown: () => Promise.resolve(),
};

const urlRule = "must be an absolute http or https URL";
const headersRule =
  "must be comma-separated key=value pairs with percent-encoded values";

function httpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function headersOf(value: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const pair of value.split(",")) {
    if (pair.trim() === "") continue;
    const eq = pair.indexOf("=");
    const key = eq > 0 ? pair.slice(0, eq).trim() : "";
    const raw = eq > 0 ? pair.slice(eq + 1).trim() : "";
    let decoded: string | undefined;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = undefined;
    }
    if (key === "" || raw === "" || decoded === undefined) return undefined;
    out[key] = decoded;
  }
  return out;
}

function ratioOf(value: string): number | undefined {
  const ratio = Number(value);
  return /^\d+(\.\d+)?$/.test(value) && ratio >= 0 && ratio <= 1
    ? ratio
    : undefined;
}

/** As OTLP exporters resolve the general endpoint themselves. */
function signalUrl(
  own: string | undefined,
  general: string,
  path: "v1/traces" | "v1/logs",
): string {
  return own ?? `${general.endsWith("/") ? general : `${general}/`}${path}`;
}

/**
 * Every setting is checked whether telemetry is on or not, as the server
 * checks them, and a refusal names the setting and never its value, which
 * may hold a credential.
 */
export function readTelemetry(
  env: Readonly<Record<string, string | undefined>>,
): TelemetrySettings | undefined {
  const present = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
  const problems: string[] = [];
  const url = (name: string): string | undefined => {
    const value = present(name);
    if (value !== undefined && !httpUrl(value)) {
      problems.push(`${name} ${urlRule}`);
    }
    return value;
  };
  const headers = (name: string): Record<string, string> => {
    const value = present(name);
    if (value === undefined) return {};
    const parsed = headersOf(value);
    if (parsed === undefined) problems.push(`${name} ${headersRule}`);
    return parsed ?? {};
  };
  const general = url("OTEL_EXPORTER_OTLP_ENDPOINT");
  const traces = url("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
  const logs = url("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT");
  const shared = headers("OTEL_EXPORTER_OTLP_HEADERS");
  const tracesHeaders = headers("OTEL_EXPORTER_OTLP_TRACES_HEADERS");
  const logsHeaders = headers("OTEL_EXPORTER_OTLP_LOGS_HEADERS");
  const posthogHost = url("MARFA_POSTHOG_HOST");
  const posthogToken = present("MARFA_POSTHOG_PROJECT_TOKEN");
  const ratioText = present("MARFA_OTEL_SAMPLE_RATIO");
  const ratio = ratioText === undefined ? 1 : ratioOf(ratioText);
  if (ratio === undefined) {
    problems.push("MARFA_OTEL_SAMPLE_RATIO must be a number from 0 to 1");
  }
  // A signal's own endpoint and the exception settings only refine or extend
  // the general endpoint, which turns telemetry on.
  if (general === undefined) {
    for (const [name, value] of [
      ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", traces],
      ["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", logs],
      ["MARFA_POSTHOG_HOST", posthogHost],
      ["MARFA_POSTHOG_PROJECT_TOKEN", posthogToken],
    ] as const) {
      if (value !== undefined) {
        problems.push(`${name} needs OTEL_EXPORTER_OTLP_ENDPOINT set too`);
      }
    }
  }
  // With one alone no exception could be reported.
  if (posthogHost !== undefined && posthogToken === undefined) {
    problems.push(
      "MARFA_POSTHOG_HOST needs MARFA_POSTHOG_PROJECT_TOKEN set too",
    );
  }
  if (posthogToken !== undefined && posthogHost === undefined) {
    problems.push(
      "MARFA_POSTHOG_PROJECT_TOKEN needs MARFA_POSTHOG_HOST set too",
    );
  }
  if (problems.length > 0) throw new ConfigurationError(problems.join("; "));
  if (general === undefined) return undefined;
  return {
    serviceName: present("OTEL_SERVICE_NAME"),
    tracesEndpoint: signalUrl(traces, general, "v1/traces"),
    logsEndpoint: signalUrl(logs, general, "v1/logs"),
    tracesHeaders: { ...shared, ...tracesHeaders },
    logsHeaders: { ...shared, ...logsHeaders },
    sampleRatio: ratio ?? 1,
    exceptions:
      posthogHost === undefined || posthogToken === undefined
        ? undefined
        : { host: posthogHost, token: posthogToken },
  };
}

/** A header usually carries the collector's credential, and the PostHog
 *  token is one. One too short to redact without redacting ordinary words is
 *  left out, as the kit's own secrets are refused. */
export function telemetrySecrets(settings: TelemetrySettings): string[] {
  return [
    ...new Set([
      ...Object.values(settings.tracesHeaders),
      ...Object.values(settings.logsHeaders),
      ...(settings.exceptions === undefined ? [] : [settings.exceptions.token]),
    ]),
  ].filter((value) => value.length >= shortestSecret);
}

/**
 * Loads the OpenTelemetry SDK, which happens only here, once telemetry is
 * configured. A failure to load or start it leaves the connector running
 * without it, with a warning.
 */
export async function startTelemetry(
  settings: TelemetrySettings,
  connectorName: string,
  logger: Logger,
  clock: Clock,
  random: () => number,
): Promise<Telemetry> {
  try {
    const sdk = await import("./telemetry-sdk.js");
    return await sdk.exporting(settings, connectorName, logger, clock, random);
  } catch (error) {
    logger.warn(
      `telemetry could not be started, so the connector runs without it: ${error instanceof Error ? error.message : String(error)}`,
    );
    return noTelemetry;
  }
}
