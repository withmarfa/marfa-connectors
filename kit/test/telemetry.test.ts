import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { start } from "../src/main.js";
import { telemetryBoundMs } from "../src/telemetry.js";
import {
  blackHole,
  closedAddress,
  startCollector,
  type Collector,
} from "./collector.js";
import { Harness, testConnector, vendor } from "./harness.js";

// Counts each load of the module that holds every OpenTelemetry import.
const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/telemetry-sdk.js", async (importOriginal) => {
  loads.count += 1;
  return importOriginal();
});

const one = { source_id: "a:1", properties: { title: "One" } };

/** Characters that URL encoding changes, so its spellings differ. */
const secret = "vendor/secret+value=with&chars";
const encoded = [
  encodeURIComponent(secret),
  new URLSearchParams({ s: secret }).toString().slice(2),
];

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

const on = (
  extra: Record<string, string> = {},
): Record<string, string | undefined> => ({
  OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
  ...extra,
});

const warnings = (): string[] =>
  harness.lines.filter((line) => line.includes(" warn "));

// First in the file: the module is counted once loaded, and stays loaded.
describe("without an endpoint", () => {
  it("loads no OpenTelemetry module, sends nothing and writes the same lines", async () => {
    const off = await Harness.create();
    try {
      expect(
        await off.once(vendor([one]), {
          OTEL_SERVICE_NAME: "named",
          MARFA_OTEL_SAMPLE_RATIO: "1",
          OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20abcdefghijk",
        }),
      ).toBe(0);
      expect(loads.count).toBe(0);

      // The witness: the same run with an endpoint loads it and sends.
      expect(await harness.once(vendor([one]), on())).toBe(0);
      expect(loads.count).toBe(1);
      expect(collector.spans()).toHaveLength(1);
      expect(off.lines).toEqual(harness.lines);
    } finally {
      await off.close();
    }
  });

  it("is reached only through one dynamic import", () => {
    const dir = resolve(import.meta.dirname, "../src");
    const sources = readdirSync(dir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({
        name,
        text: readFileSync(resolve(dir, name), "utf8"),
      }));
    expect(
      sources
        .filter(({ text }) => text.includes("@opentelemetry/"))
        .map(({ name }) => name),
    ).toEqual(["telemetry-sdk.ts"]);
    const importers = sources.filter(({ text }) =>
      text.includes("telemetry-sdk.js"),
    );
    expect(importers.map(({ name }) => name)).toEqual(["telemetry.ts"]);
    const importer = importers[0]?.text ?? "";
    expect(importer).toMatch(/await import\("\.\/telemetry-sdk\.js"\)/);
    expect(importer).not.toMatch(/^import [^(]*telemetry-sdk/m);
  });
});

describe("with an endpoint", () => {
  it("exports the run's trace and every log line, stamped with the connector's name", async () => {
    expect(await harness.once(vendor([one]), on())).toBe(0);
    const spans = collector.spans();
    expect(spans).toHaveLength(1);
    const [run] = spans;
    expect(run?.name).toBe("connector run");
    expect(run?.attributes["marfa.connector.trigger"]).toBe("schedule");
    expect(run?.attributes["marfa.connector.outcome"]).toBe("succeeded");
    expect(run?.status?.code ?? 0).not.toBe(2);
    expect(run?.resource["service.name"]).toBe("test");
    expect(run?.resource["marfa.connector.name"]).toBe("test");

    const records = collector.logRecords();
    // Each line the log wrote, without its timestamp, in order.
    expect(records.map((record) => record.body)).toEqual(
      harness.lines.map((line) => line.split(" ").slice(2).join(" ")),
    );
    expect(records.every((r) => r.resource["service.name"] === "test")).toBe(
      true,
    );
    const succeeded = records.find((r) => r.body.startsWith("run succeeded"));
    expect(succeeded?.severityText).toBe("INFO");
    expect(succeeded?.traceId).toBe(run?.traceId);
    expect(succeeded?.spanId).toBe(run?.spanId);
  });

  it("sends a failed run's error, as the span's exception and an error record", async () => {
    const failing = vendor([one]);
    failing.fail = new Error("the vendor answered 503");
    expect(await harness.once(failing, on())).toBe(1);
    const [run] = collector.spans();
    expect(run?.status?.code).toBe(2);
    expect(run?.attributes["marfa.connector.outcome"]).toBe("failed");
    const exception = run?.events.find((event) => event.name === "exception");
    expect(exception?.attributes["exception.message"]).toBe(
      "the vendor answered 503",
    );
    expect(exception?.attributes["exception.type"]).toBe("Error");
    expect(exception?.attributes["exception.stacktrace"]).toContain(
      "the vendor answered 503",
    );
    const failed = collector
      .logRecords()
      .find((record) => record.body.startsWith("run failed"));
    expect(failed?.severityText).toBe("ERROR");
    expect(failed?.traceId).toBe(run?.traceId);
  });

  it("names the service OTEL_SERVICE_NAME where it is set, and keeps the connector's name beside it", async () => {
    await harness.once(vendor([one]), on({ OTEL_SERVICE_NAME: "connectors" }));
    const [run] = collector.spans();
    expect(run?.resource["service.name"]).toBe("connectors");
    expect(run?.resource["marfa.connector.name"]).toBe("test");
    expect(collector.logRecords()[0]?.resource["service.name"]).toBe(
      "connectors",
    );
  });

  it("posts each signal under the endpoint, or to its own endpoint as written, with its headers", async () => {
    await harness.once(
      vendor([one]),
      on({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector.url}/custom/spans/traces`,
        OTEL_EXPORTER_OTLP_HEADERS: "x-general=one,x-both=general",
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: "x-both=logs%20own",
      }),
    );
    const traces = collector.posts.filter((post) =>
      post.path.endsWith("/traces"),
    );
    const logs = collector.posts.filter((post) => post.path.endsWith("/logs"));
    expect(traces.map((post) => post.path)).toEqual(["/custom/spans/traces"]);
    expect(new Set(logs.map((post) => post.path))).toEqual(
      new Set(["/v1/logs"]),
    );
    expect(traces[0]?.headers["x-general"]).toBe("one");
    expect(traces[0]?.headers["x-both"]).toBe("general");
    expect(logs[0]?.headers["x-general"]).toBe("one");
    expect(logs[0]?.headers["x-both"]).toBe("logs own");
  });

  it("exports only the share of succeeded runs MARFA_OTEL_SAMPLE_RATIO names, and every failed one", async () => {
    await harness.once(vendor([one]), on({ MARFA_OTEL_SAMPLE_RATIO: "0" }));
    expect(collector.spans()).toEqual([]);
    // Its log lines are sent whatever the ratio.
    expect(collector.logRecords().length).toBeGreaterThan(0);
    const failing = vendor([one]);
    failing.fail = new Error("the vendor answered 503");
    await harness.once(failing, on({ MARFA_OTEL_SAMPLE_RATIO: "0" }));
    expect(collector.spans().map((span) => span.status?.code)).toEqual([2]);
  });

  it("sends what waits when the process is told to stop", async () => {
    const held = vendor([one]);
    const running = start(
      testConnector(held),
      harness.runtime(["--every", "1h"], on()),
    );
    await vi.waitFor(() => {
      expect(harness.lines.some((line) => line.includes("run succeeded"))).toBe(
        true,
      );
    });
    expect(collector.spans()).toEqual([]);
    const asked = Date.now();
    harness.stop();
    expect(await running).toBe(0);
    expect(Date.now() - asked).toBeLessThan(telemetryBoundMs);
    expect(collector.spans()).toHaveLength(1);
    expect(collector.logRecords().map((record) => record.body)).toContain(
      "asked to stop",
    );
  });
});

describe("a secret", () => {
  const leaking = () => {
    const held = vendor([one]);
    held.read = (context) => {
      const minted = `minted/${secret}`;
      context.secret(minted);
      context.log.info(`the vendor took ${secret} and ${encoded.join(" ")}`);
      context.log.warn(`minted ${minted}`);
      throw new Error(
        `the vendor refused ${secret} (${encoded.join(", ")}) and ${minted}`,
      );
    };
    return held;
  };

  const everything = (): string =>
    collector.posts.map((post) => post.text).join("\n");

  it("never leaves the process, in any spelling, through logs, spans or errors", async () => {
    expect(await harness.once(leaking(), on({ TEST_TOKEN: secret }))).toBe(1);
    const sent = everything();
    expect(collector.spans()).toHaveLength(1);
    expect(sent).toContain("[redacted]");
    for (const spelling of [secret, ...encoded]) {
      expect(sent).not.toContain(spelling);
    }
    expect(sent).not.toContain("minted/");
    const [run] = collector.spans();
    expect(
      run?.events.find((event) => event.name === "exception")?.attributes[
        "exception.stacktrace"
      ],
    ).toContain("[redacted]");
  });

  it("is sent as written when it is not a secret, so the check above has something to find", async () => {
    // The same run with the value in no secret reaches every channel.
    expect(await harness.once(leaking(), on())).toBe(1);
    const sent = everything();
    for (const spelling of [secret, ...encoded]) {
      expect(sent).toContain(spelling);
    }
    const [run] = collector.spans();
    const exception = run?.events.find((event) => event.name === "exception");
    expect(exception?.attributes["exception.message"]).toContain(secret);
    expect(exception?.attributes["exception.stacktrace"]).toContain(secret);
    expect(run?.status?.message).toContain(secret);
    expect(
      collector.logRecords().some((record) => record.body.includes(secret)),
    ).toBe(true);
    // A secret kept during the run is redacted all the same.
    expect(sent).not.toContain("minted/");
  });

  it("in a telemetry header is kept out of the log and of what is sent", async () => {
    const token = "Bearer collector-token-value";
    const held = vendor([one]);
    held.read = (context) => {
      context.log.info(`the header is ${token}`);
      return Promise.resolve();
    };
    await harness.once(
      held,
      on({
        OTEL_EXPORTER_OTLP_HEADERS: `authorization=${encodeURIComponent(token)}`,
      }),
    );
    expect(collector.posts[0]?.headers.authorization).toBe(token);
    expect(harness.lines.join("\n")).not.toContain("collector-token-value");
    expect(everything()).not.toContain("collector-token-value");
  });
});

describe("a collector that cannot be reached", () => {
  it("neither fails nor holds up a run, and is warned of once, without a secret", async () => {
    const away = await closedAddress();
    const asked = Date.now();
    expect(
      await harness.once(vendor([one]), {
        OTEL_EXPORTER_OTLP_ENDPOINT: away,
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=collector-token-value",
      }),
    ).toBe(0);
    expect(Date.now() - asked).toBeLessThan(telemetryBoundMs + 2000);
    expect(harness.lastRun().outcome).toBe("succeeded");
    const said = warnings().filter((line) => line.includes("telemetry"));
    expect(said).toHaveLength(1);
    expect(said[0]).not.toContain("collector-token-value");
  });

  it("that takes a post and never answers is given up within the bound", async () => {
    const hung = await startCollector("hang");
    try {
      const asked = Date.now();
      expect(
        await harness.once(vendor([one]), {
          OTEL_EXPORTER_OTLP_ENDPOINT: hung.url,
        }),
      ).toBe(0);
      expect(Date.now() - asked).toBeLessThan(telemetryBoundMs + 2000);
      expect(hung.posts.length).toBeGreaterThan(0);
      expect(
        warnings().filter((line) => line.includes("telemetry")).length,
      ).toBeLessThanOrEqual(1);
    } finally {
      await hung.close();
    }
  });
});

/** Runs a connector on the built kit as its own process, as launchd or a
 *  container does, and answers how long the process took to end. */
async function processLasts(env: Record<string, string>): Promise<number> {
  const place = await mkdtemp(join(tmpdir(), "telemetry-process-"));
  const kit = pathToFileURL(resolve(import.meta.dirname, "../dist/index.js"));
  const script = join(place, "connector.mjs");
  await writeFile(
    script,
    `import { defineConnector, main } from ${JSON.stringify(kit.href)};
await main(defineConnector({
  name: "probe",
  source: "probe",
  types: [{ type: { id: "probe.entry", label: "Entry", description: "An entry.", fields: { title: { type: "string", required: true } } }, fields: ["title"] }],
  async run() {},
}));
`,
  );
  const began = Date.now();
  try {
    await new Promise<void>((done) => {
      execFile(
        process.execPath,
        [script, "--once"],
        { env: { PATH: process.env["PATH"] ?? "", ...env }, timeout: 20_000 },
        () => {
          done();
        },
      );
    });
    return Date.now() - began;
  } finally {
    await rm(place, { recursive: true, force: true });
  }
}

describe("a collector that drops what is sent to it", () => {
  it("never keeps the process from ending past the bound", async () => {
    const hole = await blackHole();
    try {
      const lasted = await processLasts({
        MARFA_API_URL: await closedAddress(),
        MARFA_API_KEY: "marfa-key-value-123456",
        OTEL_EXPORTER_OTLP_ENDPOINT: hole.url,
      });
      // Starting Node and loading the kit take a second or so of their own.
      expect(lasted).toBeLessThan(telemetryBoundMs + 3000);
    } finally {
      hole.close();
    }
  }, 30_000);
});

describe("a setting that cannot be used", () => {
  it.each([
    [
      { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces" },
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT needs OTEL_EXPORTER_OTLP_ENDPOINT set too",
    ],
    [
      { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4318/v1/logs" },
      "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT needs OTEL_EXPORTER_OTLP_ENDPOINT set too",
    ],
    [
      { OTEL_EXPORTER_OTLP_ENDPOINT: "collector:4318" },
      "OTEL_EXPORTER_OTLP_ENDPOINT must be an absolute http or https URL",
    ],
    [
      { OTEL_EXPORTER_OTLP_ENDPOINT: "not a url at all" },
      "OTEL_EXPORTER_OTLP_ENDPOINT must be an absolute http or https URL",
    ],
    [
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "ftp://127.0.0.1/logs",
      },
      "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT must be an absolute http or https URL",
    ],
    [
      { OTEL_EXPORTER_OTLP_HEADERS: "authorization" },
      "OTEL_EXPORTER_OTLP_HEADERS must be comma-separated key=value pairs with percent-encoded values",
    ],
    [
      { OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x=%E0%A4%A" },
      "OTEL_EXPORTER_OTLP_TRACES_HEADERS must be comma-separated key=value pairs with percent-encoded values",
    ],
    [
      { MARFA_OTEL_SAMPLE_RATIO: "1.5" },
      "MARFA_OTEL_SAMPLE_RATIO must be a number from 0 to 1",
    ],
    [
      { MARFA_OTEL_SAMPLE_RATIO: "-0.5" },
      "MARFA_OTEL_SAMPLE_RATIO must be a number from 0 to 1",
    ],
  ])("stops the start, naming it: %o", async (env, message) => {
    expect(await harness.once(vendor([one]), env)).toBe(2);
    expect(harness.lines).toHaveLength(1);
    expect(harness.lines[0]).toContain(` error ${message}`);
    for (const value of Object.values(env)) {
      expect(harness.lines[0]).not.toContain(value);
    }
    expect(harness.server.requests).toEqual([]);
  });

  it("names every one at once", async () => {
    expect(
      await harness.once(vendor([one]), {
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:4318/v1/logs",
        MARFA_OTEL_SAMPLE_RATIO: "two",
      }),
    ).toBe(2);
    expect(harness.lines[0]).toContain("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT");
    expect(harness.lines[0]).toContain("MARFA_OTEL_SAMPLE_RATIO");
  });
});

it("lists the telemetry settings in its help", async () => {
  expect(
    await start(testConnector(vendor()), harness.runtime(["--help"])),
  ).toBe(0);
  expect(harness.lines.join("\n")).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
});
