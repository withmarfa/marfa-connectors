import { afterEach, beforeEach, expect, it } from "vitest";
import { start } from "../src/main.js";
import { startCollector, type Collector } from "./collector.js";
import { Harness, closedUrl, testConnector, vendor } from "./harness.js";

const one = { source_id: "a:1", properties: { title: "One" } };

let harness: Harness;
let collector: Collector;
beforeEach(async () => {
  harness = await Harness.create();
  collector = await startCollector();
});
afterEach(async () => {
  await harness.close();
  await collector.close();
});

const telemetry = (): Record<string, string | undefined> => ({
  OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
});

it("logs the reason a connector cannot start, and its copy reaches the OpenTelemetry logs", async () => {
  const closed = await closedUrl();
  expect(
    await harness.once(vendor([one]), {
      ...telemetry(),
      MARFA_API_URL: closed,
    }),
  ).toBe(1);
  const reason = `could not start: the server at MARFA_API_URL (${closed}) did not answer`;
  expect(harness.lines.join("\n")).toContain(reason);
  expect(
    collector.logRecords().some((record) => record.body.includes(reason)),
  ).toBe(true);
  expect(harness.server.requests).toEqual([]);
});

it.each([
  [
    "a JSON value in it",
    `invalid settings ${JSON.stringify({ region: "unknown" })}`,
    "cannot start: invalid settings [removed]",
  ],
  [
    "more than the log allows",
    "x".repeat(2500),
    `cannot start: ${"x".repeat(2500)}`.slice(0, 1999) + "…",
  ],
])(
  "logs the same text, and no other, in the log and the OpenTelemetry logs when the check's message has %s",
  async (_name, message, expected) => {
    const connector = testConnector(vendor([one]));
    const code = await start(
      {
        ...connector,
        checkEnv: () => {
          throw new Error(message);
        },
      },
      harness.runtime(["--once"], telemetry()),
    );
    expect(code).toBe(2);
    expect((harness.lines.at(-1) ?? "").endsWith(` error ${expected}`)).toBe(
      true,
    );
    expect(collector.logRecords().map((record) => record.body)).toContain(
      expected,
    );
  },
);
