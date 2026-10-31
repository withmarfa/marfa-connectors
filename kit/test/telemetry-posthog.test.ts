import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { closedAddress, startCollector, type Collector } from "./collector.js";
import { Harness, vendor } from "./harness.js";
import {
  failFromSource,
  item,
  planted,
  requestBody,
  sourced,
} from "./planted.js";

// Counts each load of the module that holds every PostHog import.
const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/telemetry-posthog.js", async (importOriginal) => {
  loads.count += 1;
  return importOriginal();
});

const one = { source_id: "a:1", properties: { title: "One" } };

interface SentEvent {
  event: string;
  properties: Record<string, unknown> & {
    $exception_list?: {
      type?: string;
      value?: string;
      stacktrace?: { frames?: Record<string, unknown>[] };
    }[];
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

/** The events the stub took, with the project token each came under. */
function events(stub: Collector): (SentEvent & { token: unknown })[] {
  return stub.posts.flatMap((post) => {
    const body = JSON.parse(post.text) as {
      api_key?: unknown;
      batch?: SentEvent[];
    };
    return (body.batch ?? []).map((sent) => ({ ...sent, token: body.api_key }));
  });
}

const exceptions = (stub: Collector) =>
  events(stub).filter((sent) => sent.event === "$exception");

const failing = (error: Error = new Error("the vendor answered 503")) => {
  const held = vendor([one]);
  held.fail = error;
  return held;
};

// First in the file: the module is counted once loaded, and stays loaded.
describe("without all three settings", () => {
  it("loads no PostHog module and sends nothing, whether the OTLP endpoint is set or not", async () => {
    expect(await harness.once(failing(), {})).toBe(1);
    expect(
      await harness.once(failing(), {
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
      }),
    ).toBe(1);
    expect(loads.count).toBe(0);
    expect(posthog.posts).toEqual([]);
  });

  it.each([
    [
      { MARFA_POSTHOG_HOST: "http://127.0.0.1:1" },
      "MARFA_POSTHOG_HOST needs MARFA_POSTHOG_PROJECT_TOKEN set too",
    ],
    [
      { MARFA_POSTHOG_PROJECT_TOKEN: planted.project },
      "MARFA_POSTHOG_PROJECT_TOKEN needs MARFA_POSTHOG_HOST set too",
    ],
    [
      { MARFA_POSTHOG_HOST: "not a url", MARFA_POSTHOG_PROJECT_TOKEN: "x" },
      "MARFA_POSTHOG_HOST must be an absolute http or https URL",
    ],
  ])(
    "stops the start, naming the setting and never a value, when one is missing or unusable: %o",
    async (extra, message) => {
      expect(
        await harness.once(failing(), {
          OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
          ...extra,
        }),
      ).toBe(2);
      expect(harness.lines).toHaveLength(1);
      expect(harness.lines[0]).toContain(` error ${message}`);
      expect(harness.lines[0]).not.toContain(planted.project);
      expect(harness.server.requests).toEqual([]);
      expect(loads.count).toBe(0);
      expect(posthog.posts).toEqual([]);
    },
  );

  it("stops the start when the PostHog settings come without the OTLP endpoint", async () => {
    expect(
      await harness.once(failing(), {
        MARFA_POSTHOG_HOST: posthog.url,
        MARFA_POSTHOG_PROJECT_TOKEN: planted.project,
      }),
    ).toBe(2);
    expect(harness.lines).toHaveLength(1);
    expect(harness.lines[0]).toContain(
      "MARFA_POSTHOG_HOST needs OTEL_EXPORTER_OTLP_ENDPOINT set too",
    );
    expect(harness.lines[0]).toContain(
      "MARFA_POSTHOG_PROJECT_TOKEN needs OTEL_EXPORTER_OTLP_ENDPOINT set too",
    );
    expect(harness.lines[0]).not.toContain(planted.project);
    expect(loads.count).toBe(0);
    expect(posthog.posts).toEqual([]);
  });

  // The witness: with all three set, the same failing run loads it and sends.
  it("is the only reason nothing was sent: the same run with all three loads the module and sends", async () => {
    expect(await harness.once(failing(), all())).toBe(1);
    expect(loads.count).toBe(1);
    expect(exceptions(posthog)).toHaveLength(1);
  });

  it("is reached only through one dynamic import, inside the OpenTelemetry module", () => {
    const dir = resolve(import.meta.dirname, "../src");
    const sources = readdirSync(dir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({
        name,
        text: readFileSync(resolve(dir, name), "utf8"),
      }));
    expect(
      sources
        .filter(({ text }) => text.includes("posthog-node"))
        .map(({ name }) => name),
    ).toEqual(["telemetry-posthog.ts"]);
    const importers = sources.filter(({ text }) =>
      text.includes("telemetry-posthog.js"),
    );
    expect(importers.map(({ name }) => name)).toEqual(["telemetry-sdk.ts"]);
    const importer = importers[0]?.text ?? "";
    expect(importer).toMatch(/await import\("\.\/telemetry-posthog\.js"\)/);
    // A type import is erased; any other would load it with the module.
    expect(importer).not.toMatch(/^import (?!type )[^(;]*telemetry-posthog/m);
  });
});

describe("a failed run", () => {
  it("sends one exception with the error's type, message, stack frames and the connector's name, and no person", async () => {
    class VendorError extends Error {
      override name = "VendorError";
    }
    expect(
      await harness.once(
        failing(new VendorError("the vendor answered 503")),
        all(),
      ),
    ).toBe(1);
    const sent = exceptions(posthog);
    expect(sent).toHaveLength(1);
    const [exception] = sent;
    expect(exception?.token).toBe(planted.project);
    const [error] = exception?.properties.$exception_list ?? [];
    expect(error?.type).toBe("VendorError");
    expect(error?.value).toBe("the vendor answered 503");
    const frames = error?.stacktrace?.frames ?? [];
    expect(frames.length).toBeGreaterThan(0);
    expect(
      frames.some((frame) =>
        String(frame["filename"]).includes("telemetry-posthog.test"),
      ),
    ).toBe(true);
    expect(exception?.properties["marfa.connector.name"]).toBe("test");
    expect(exception?.properties["service.name"]).toBe("test");
    expect(exception?.properties["marfa.connector.trigger"]).toBe("schedule");
    expect(exception?.properties["deployment.environment"]).toBe("production");
    expect(exception?.properties["$process_person_profile"]).toBe(false);
    // Nothing else is sent to PostHog.
    expect(events(posthog).map((sent) => sent.event)).toEqual(["$exception"]);
  });

  it("sends the exception of a run that threw a value that is no error", async () => {
    expect(
      await harness.once(
        failing("the vendor fell over" as unknown as Error),
        all(),
      ),
    ).toBe(1);
    const [exception] = exceptions(posthog);
    expect(exception?.properties.$exception_list?.[0]?.value).toBe(
      "the vendor fell over",
    );
    const frames =
      exception?.properties.$exception_list?.[0]?.stacktrace?.frames ?? [];
    expect(
      frames.filter((frame) =>
        JSON.stringify(frame).includes("exception-text"),
      ),
    ).toEqual([]);
  });

  it("sends nothing for a run that succeeded", async () => {
    expect(await harness.once(vendor([one]), all())).toBe(0);
    expect(posthog.posts).toEqual([]);
  });

  it("is sent whatever the trace sample ratio, as the failed run's trace is", async () => {
    expect(
      await harness.once(failing(), all({ MARFA_OTEL_SAMPLE_RATIO: "0" })),
    ).toBe(1);
    expect(exceptions(posthog)).toHaveLength(1);
    // The run that succeeded is the one the ratio drops.
    await harness.once(vendor([one]), all({ MARFA_OTEL_SAMPLE_RATIO: "0" }));
    expect(collector.spans().map((span) => span.status?.code)).toEqual([2]);
    expect(exceptions(posthog)).toHaveLength(1);
  });

  it("is sent once for each failed run, and the run's own span still carries the exception", async () => {
    await harness.once(failing(), all());
    const [run] = collector.spans();
    expect(run?.events.map((event) => event.name)).toEqual(["exception"]);
    expect(exceptions(posthog)).toHaveLength(1);
  });
});

describe("what a failed run's exception holds", () => {
  const leaking = (keeping = true) => {
    const held = vendor([one]);
    held.read = (context) => {
      if (keeping) context.secret(planted.minted);
      const cause = new Error(
        `the vendor refused ${JSON.stringify(item)} for ${planted.credential}`,
      );
      Object.assign(cause, { body: item });
      class VendorError extends Error {
        override name = "VendorError";
        readonly body = requestBody;
        readonly request = { headers: { authorization: planted.header } };
      }
      throw new VendorError(
        `the vendor answered 400 to ${JSON.stringify(requestBody)} with ${planted.minted} and ${planted.credential} under ${planted.header} and ${planted.project}`,
        { cause },
      );
    };
    return held;
  };

  const run = () =>
    harness.once(
      leaking(),
      all({
        TEST_TOKEN: planted.credential,
        OTEL_EXPORTER_OTLP_HEADERS: `authorization=${planted.header}`,
      }),
    );

  /** Everything the stub took except the token the event is sent under. */
  const sentText = (): string =>
    JSON.stringify(
      events(posthog).map(({ event, properties }) => ({ event, properties })),
    );

  it("holds no credential, token, item content or request body, and is still sent", async () => {
    expect(await run()).toBe(1);
    // The witness: the exception was sent, with what is safe to send.
    const [exception] = exceptions(posthog);
    const [error, ...causes] = exception?.properties.$exception_list ?? [];
    expect(events(posthog)).toHaveLength(1);
    expect(error?.type).toBe("VendorError");
    expect(error?.value).toContain("the vendor answered 400 to");
    expect(error?.value).toContain("[redacted]");
    expect(error?.stacktrace?.frames?.length).toBeGreaterThan(0);
    expect(exception?.properties["marfa.connector.name"]).toBe("test");
    expect(causes.map((cause) => cause.type)).toEqual(["Error"]);
    expect(causes[0]?.value).toContain("the vendor refused");

    const sent = sentText();
    for (const value of [
      planted.credential,
      planted.minted,
      planted.header,
      planted.project,
      planted.content,
      planted.request,
    ]) {
      expect(sent).not.toContain(value);
    }
  });

  it("holds all of them when none is kept as a secret, so the check above has something to find", async () => {
    // The same failure, with nothing declared or kept: the secrets are sent as
    // written, which is what keeping them removes.
    expect(
      await harness.once(
        leaking(false),
        all({ TEST_TOKEN: "an-unrelated-value-1234" }),
      ),
    ).toBe(1);
    const sent = sentText();
    for (const value of [planted.credential, planted.minted, planted.header]) {
      expect(sent).toContain(value);
    }
    // The project token is kept whatever else is.
    expect(sent).not.toContain(planted.project);
  });

  it("holds no secret from the source lines PostHog attaches beside each frame", async () => {
    const held = vendor([one]);
    held.read = () => {
      failFromSource();
    };
    // The witness: undeclared, the source line travels with the frame.
    expect(
      await harness.once(held, all({ TEST_TOKEN: "an-unrelated-value-1234" })),
    ).toBe(1);
    expect(sentText()).toContain(sourced);
    posthog.posts.length = 0;
    expect(await harness.once(held, all({ TEST_TOKEN: sourced }))).toBe(1);
    expect(exceptions(posthog)).toHaveLength(1);
    expect(sentText()).not.toContain(sourced);
    expect(sentText()).toContain("[redacted]");
  });

  it("is held to the same rule for a secret the log learns after the error was made", async () => {
    const held = vendor([one]);
    held.read = (context) => {
      const error = new Error(`the vendor said ${planted.minted}`);
      context.secret(planted.minted);
      throw error;
    };
    expect(await harness.once(held, all())).toBe(1);
    expect(JSON.stringify(events(posthog))).not.toContain(planted.minted);
    expect(exceptions(posthog)).toHaveLength(1);
  });
});

describe("a PostHog host that cannot be reached", () => {
  // The SDK writes a failed send to the console with its stack; the kit warns
  // once through its log instead.
  let console_: MockInstance<typeof console.error>;
  beforeEach(() => {
    console_ = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    console_.mockRestore();
  });
  const told = (): string[] =>
    harness.lines.filter((line) => line.includes("telemetry could not"));

  it("neither fails nor holds up a run, and its exit code is the run's", async () => {
    const away = await closedAddress();
    expect(
      await harness.once(failing(), all({ MARFA_POSTHOG_HOST: away })),
    ).toBe(1);
    expect(harness.lastRun().outcome).toBe("failed");
    expect(told()).toHaveLength(1);
    expect(told()[0]).toContain("ECONNREFUSED");
    expect(console_).not.toHaveBeenCalled();
    expect(harness.lines.join("\n")).not.toContain(planted.project);
  });

  it("that takes a post and never answers is given up within the bound", async () => {
    const hung = await startCollector("hang");
    try {
      expect(
        await harness.once(failing(), all({ MARFA_POSTHOG_HOST: hung.url })),
      ).toBe(1);
      expect(hung.posts.length).toBeGreaterThan(0);
      expect(told()).toHaveLength(1);
      expect(console_).not.toHaveBeenCalled();
    } finally {
      await hung.close();
    }
  });

  it("that answers with a refusal leaves the exit code alone", async () => {
    const refusing = await startCollector("refuse");
    try {
      expect(
        await harness.once(
          failing(),
          all({ MARFA_POSTHOG_HOST: refusing.url }),
        ),
      ).toBe(1);
      expect(refusing.posts.length).toBeGreaterThan(0);
      expect(told()).toHaveLength(1);
      expect(told()[0]).toContain("503");
      expect(console_).not.toHaveBeenCalled();
    } finally {
      await refusing.close();
    }
  });
});

/** Runs a connector that fails on the built kit as its own process, as
 *  launchd or a container does, and answers how it ended and how long it took. */
async function failsAs(
  env: Record<string, string>,
): Promise<{ code: number | null }> {
  const place = await mkdtemp(join(tmpdir(), "telemetry-posthog-"));
  const kit = pathToFileURL(resolve(import.meta.dirname, "../dist/index.js"));
  const script = join(place, "connector.mjs");
  await writeFile(
    script,
    `import { defineConnector, main } from ${JSON.stringify(kit.href)};
await main(defineConnector({
  name: "test",
  source: "test",
  types: [{ type: { id: "test.entry", label: "Entry", description: "An entry from the test vendor.", fields: { title: { type: "string", required: true }, note: { type: "string" }, link: { type: "url" }, vendor_id: { type: "string" } } }, fields: ["title", "note", "link", "vendor_id"] }],
  async run() { throw new Error("the vendor answered 503"); },
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
            MARFA_API_URL: harness.server.url,
            MARFA_API_KEY: harness.server.key,
            ...env,
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
    return { code };
  } finally {
    await rm(place, { recursive: true, force: true });
  }
}

describe("a PostHog host that takes a post and never answers", () => {
  it("never keeps the process from ending past the bound, or changes how it ends", async () => {
    const hung = await startCollector("hang");
    try {
      const without = await failsAs({
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
      });
      const hungUp = await failsAs({
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
        MARFA_POSTHOG_HOST: hung.url,
        MARFA_POSTHOG_PROJECT_TOKEN: planted.project,
      });
      expect(without.code).toBe(1);
      expect(hungUp.code).toBe(1);
      expect(hung.posts.length).toBeGreaterThan(0);
    } finally {
      await hung.close();
    }
  }, 60_000);
});
