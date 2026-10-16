import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { start } from "../src/main.js";
import { startCollector, type Collector } from "./collector.js";
import { Harness, closedUrl, testConnector, vendor } from "./harness.js";
import { planted } from "./planted.js";

const one = { source_id: "a:1", properties: { title: "One" } };

interface SentEvent {
  event: string;
  properties: Record<string, unknown> & {
    $exception_list?: { type?: string; value?: string }[];
  };
}

let harness: Harness;
let collector: Collector;
let posthog: Collector;
beforeEach(async () => {
  harness = await Harness.create();
  collector = await startCollector();
  posthog = await startCollector();
});
afterEach(async () => {
  await harness.close();
  await collector.close();
  await posthog.close();
});

/** Every setting that turns the exception report on. */
const all = (
  extra: Record<string, string> = {},
): Record<string, string | undefined> => ({
  OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
  MARFA_POSTHOG_HOST: posthog.url,
  MARFA_POSTHOG_PROJECT_TOKEN: planted.project,
  ...extra,
});

const exceptions = (stub: Collector): SentEvent[] =>
  stub.posts
    .flatMap((post) => {
      const body = JSON.parse(post.text) as { batch?: SentEvent[] };
      return body.batch ?? [];
    })
    .filter((sent) => sent.event === "$exception");

/** The one error an exception holds, or fails if it holds none. */
function only(stub: Collector): { type?: string; value?: string } {
  const sent = exceptions(stub);
  expect(sent).toHaveLength(1);
  const [error] = sent[0]?.properties.$exception_list ?? [];
  if (error === undefined) throw new Error("the exception held no error");
  return error;
}

const said = (): string => harness.lines.join("\n");

async function until(holds: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!holds()) {
    if (Date.now() > deadline) throw new Error("the condition never held");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("a connector that cannot start and ends", () => {
  it("sends one exception with the text it logged when Marfa does not answer", async () => {
    const closed = await closedUrl();
    expect(
      await harness.once(vendor([one]), all({ MARFA_API_URL: closed })),
    ).toBe(1);
    const error = only(posthog);
    expect(error.type).toBe("StartFailure");
    expect(error.value).toContain(
      `could not start: the server at MARFA_API_URL (${closed}) did not answer`,
    );
    expect(said()).toContain(error.value ?? "unreadable");
    const [sent] = exceptions(posthog);
    expect(sent?.properties["marfa.connector.name"]).toBe("test");
    expect(sent?.properties["marfa.connector.trigger"]).toBeUndefined();
    expect(sent?.properties["$process_person_profile"]).toBe(false);
    expect(harness.server.requests).toEqual([]);
  });

  it("sends one exception with the key kept out of it when the server refuses the key", async () => {
    harness.server.revoked = true;
    expect(await harness.once(vendor([one]), all())).toBe(1);
    const error = only(posthog);
    expect(error.value).toContain("MARFA_API_KEY");
    expect(error.value).toContain("revoked");
    expect(said()).toContain(error.value ?? "unreadable");
    expect(
      JSON.stringify(posthog.posts.map((post) => post.text)),
    ).not.toContain(harness.server.key);
  });

  it("sends one exception, and exits 2, when the address cannot be used", async () => {
    const redirecting = createServer((_request, response) => {
      response.writeHead(302, { Location: "http://elsewhere.invalid/" });
      response.end();
    });
    await new Promise<void>((done) => redirecting.listen(0, "127.0.0.1", done));
    const { port } = redirecting.address() as AddressInfo;
    try {
      const code = await start(
        testConnector(vendor([one])),
        harness.runtime(["--every", "5m"], {
          ...all(),
          MARFA_API_URL: `http://127.0.0.1:${String(port)}`,
        }),
      );
      expect(code).toBe(2);
      const error = only(posthog);
      expect(error.value).toContain("MARFA_API_URL");
      expect(error.value).toContain("redirect");
      expect(said()).toContain(error.value ?? "unreadable");
    } finally {
      redirecting.closeAllConnections();
      await new Promise((done) => redirecting.close(done));
    }
  });

  it("sends one exception when the registration check refuses the start", async () => {
    harness.server.grants = { permissions: ["instance.read"] };
    expect(await harness.once(vendor([one]), all())).toBe(1);
    const error = only(posthog);
    expect(error.type).toBe("StartFailure");
    expect(error.value).toContain("instance.read");
    expect(said()).toContain(error.value ?? "unreadable");
  });

  it("sends one exception when the connector's own check of its settings refuses the start", async () => {
    const connector = testConnector(vendor([one]));
    const code = await start(
      {
        ...connector,
        checkEnv: () => {
          throw new Error("TEST_TOKEN is not a token this vendor issues");
        },
      },
      harness.runtime(["--once"], all()),
    );
    expect(code).toBe(2);
    expect(only(posthog).value).toBe(
      "cannot start: TEST_TOKEN is not a token this vendor issues",
    );
  });

  it.each([
    [
      "a JSON value in it",
      `invalid settings ${JSON.stringify({ region: "unknown" })}`,
      "cannot start: invalid settings [removed]",
    ],
    [
      "more than the report allows",
      "x".repeat(2500),
      `cannot start: ${"x".repeat(2500)}`.slice(0, 1999) + "\u2026",
    ],
  ])(
    "sends the text it logged, and no other, when the check's message has %s",
    async (_name, message, expected) => {
      const connector = testConnector(vendor([one]));
      const code = await start(
        {
          ...connector,
          checkEnv: () => {
            throw new Error(message);
          },
        },
        harness.runtime(["--once"], all()),
      );
      expect(code).toBe(2);
      const logged = harness.lines.at(-1) ?? "";
      expect(logged.endsWith(` error ${expected}`)).toBe(true);
      expect(only(posthog).value).toBe(expected);
      // The same line reaches the OpenTelemetry logs.
      expect(collector.logRecords().map((record) => record.body)).toContain(
        expected,
      );
    },
  );

  it("sends nothing without the PostHog settings, which is all that stops the exception above", async () => {
    const closed = await closedUrl();
    expect(
      await harness.once(vendor([one]), {
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
        MARFA_API_URL: closed,
      }),
    ).toBe(1);
    expect(posthog.posts).toEqual([]);
    expect(
      await harness.once(vendor([one]), all({ MARFA_API_URL: closed })),
    ).toBe(1);
    expect(exceptions(posthog)).toHaveLength(1);
  });
});

describe("a connector that cannot start and tries again", () => {
  it("sends nothing for any retry, and nothing when it is stopped", async () => {
    const closed = await closedUrl();
    const exit = start(
      testConnector(vendor([one])),
      harness.runtime(["--every", "5m"], all({ MARFA_API_URL: closed })),
    );
    for (let retry = 1; retry <= 3; retry += 1) {
      await until(() => harness.clock.requested.length >= retry);
      expect(said().split("trying again in ")).toHaveLength(retry + 1);
      await harness.clock.wake(harness.clock.requested[retry - 1] ?? 0);
    }
    await until(() => harness.clock.requested.length >= 4);
    harness.stop();
    expect(await exit).toBe(0);
    expect(posthog.posts).toEqual([]);
  });

  // The witness: the same schedule, with a start that cannot be retried.
  it("sends one exception when the same schedule meets a refusal that ends it", async () => {
    harness.server.revoked = true;
    expect(
      await start(
        testConnector(vendor([one])),
        harness.runtime(["--every", "5m"], all()),
      ),
    ).toBe(1);
    expect(exceptions(posthog)).toHaveLength(1);
  });
});

describe("a failed run", () => {
  it("is reported as before: one exception of the run's own error, under its trigger", async () => {
    const held = vendor([one]);
    held.fail = new Error("the vendor answered 503");
    expect(await harness.once(held, all())).toBe(1);
    const error = only(posthog);
    expect(error.type).toBe("Error");
    expect(error.value).toBe("the vendor answered 503");
    const [sent] = exceptions(posthog);
    expect(sent?.properties["marfa.connector.trigger"]).toBe("schedule");
  });
});

describe("a process that cannot start", () => {
  it("has its exception sent before it exits", async () => {
    const closed = await closedUrl();
    const place = await mkdtemp(join(tmpdir(), "telemetry-start-"));
    const kit = pathToFileURL(resolve(import.meta.dirname, "../dist/index.js"));
    const script = join(place, "connector.mjs");
    await writeFile(
      script,
      `import { defineConnector, main } from ${JSON.stringify(kit.href)};
await main(defineConnector({
  name: "test",
  source: "test",
  types: [{ type: { id: "test.entry", label: "Entry", description: "An entry from the test vendor.", fields: { title: { type: "string", required: true } } }, fields: ["title"] }],
  async run() {},
}));
`,
    );
    try {
      const code = await new Promise<number | null>((done) => {
        execFile(
          process.execPath,
          [script, "--once"],
          {
            env: {
              PATH: process.env["PATH"] ?? "",
              MARFA_API_URL: closed,
              MARFA_API_KEY: harness.server.key,
              OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
              MARFA_POSTHOG_HOST: posthog.url,
              MARFA_POSTHOG_PROJECT_TOKEN: planted.project,
            },
            timeout: 20_000,
          },
          (error) => {
            done(
              error === null
                ? 0
                : typeof error.code === "number"
                  ? error.code
                  : null,
            );
          },
        );
      });
      expect(code).toBe(1);
      // Read only now that the process is gone: nothing waited for it.
      expect(only(posthog).value).toContain(
        `could not start: the server at MARFA_API_URL (${closed}) did not answer`,
      );
    } finally {
      await rm(place, { recursive: true, force: true });
    }
  }, 60_000);
});
