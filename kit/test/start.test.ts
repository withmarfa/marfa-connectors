import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { start } from "../src/main.js";
import { Harness, testConnector, testType, vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const entry = { source_id: "a:1", properties: { title: "One" } };

describe("configuration", () => {
  it("refuses to start without a required value, naming every one missing", async () => {
    expect(await harness.once(vendor([entry]))).toBe(0);
    const reached = harness.server.requests.length;
    expect(reached).toBeGreaterThan(0);

    const code = await harness.once(vendor([entry]), {
      MARFA_KEY: undefined,
      TEST_TOKEN: "",
    });
    expect(code).toBe(2);
    const said = harness.lines.join("\n");
    expect(said).toContain("MARFA_KEY");
    expect(said).toContain("TEST_TOKEN");
    expect(harness.server.requests.length).toBe(reached);
  });

  it("takes an optional value as absent when it is unset", async () => {
    let region: string | undefined = "unread";
    const connector = testConnector(vendor());
    const run = connector.run.bind(connector);
    const code = await start(
      {
        ...connector,
        run: async (context) => {
          region = context.env.TEST_REGION;
          await run(context);
        },
      },
      harness.runtime(["--once"]),
    );
    expect(code).toBe(0);
    expect(region).toBeUndefined();
  });

  it("refuses a schedule it cannot read", async () => {
    for (const argv of [[], ["--every"], ["--every", "soon"], ["--once", "--every", "1m"]]) {
      expect(await start(testConnector(vendor()), harness.runtime(argv))).toBe(2);
    }
    expect(harness.server.requests).toEqual([]);
  });

  it("refuses a source under a reserved prefix", async () => {
    const connector = { ...testConnector(vendor()), source: "Connector:test" };
    expect(await start(connector, harness.runtime(["--once"]))).toBe(2);
    expect(harness.server.requests).toEqual([]);
  });
});

describe("registration", () => {
  it("registers on every start, under the same registration", async () => {
    expect(await harness.once(vendor([entry]))).toBe(0);
    expect(await harness.once(vendor([entry]))).toBe(0);
    const registrations = harness.server.requestsTo("POST", "/connectors");
    expect(registrations).toHaveLength(2);
    expect(registrations[0]?.body).toEqual({
      name: "test",
      description: "A connector the kit's tests drive.",
    });
    expect(harness.server.runs).toHaveLength(2);
    expect(harness.server.heartbeats).toBeGreaterThanOrEqual(2);
  });
});

describe("the type check on start", () => {
  it("registers the type when the server has none", async () => {
    expect(await harness.once(vendor([entry]))).toBe(0);
    const registered = harness.server.requestsTo("POST", "/types");
    expect(registered).toHaveLength(1);
    expect(registered[0]?.body).toEqual(testType);
  });

  it("carries on when the server's type has the same shape, whatever its words", async () => {
    harness.server.types.set("test.entry", {
      ...testType,
      label: "Something else",
      description: "Described differently.",
      version: 3,
      fields: {
        title: { type: "string", required: true, description: "The title" },
        note: { type: "string" },
        link: { type: "url", description: "Where it lives" },
      },
    });
    expect(await harness.once(vendor([entry]))).toBe(0);
    expect(harness.server.requestsTo("POST", "/types")).toEqual([]);
    expect(harness.server.rows).toHaveLength(1);
  });

  it("reads a required list and per-field flags as the same thing", async () => {
    harness.server.types.set("test.entry", {
      id: "test.entry",
      required: ["title"],
      fields: { title: { type: "string" }, note: { type: "string" }, link: { type: "url" } },
    });
    expect(await harness.once(vendor([entry]))).toBe(0);
    expect(harness.server.rows).toHaveLength(1);
  });

  it("stops with the difference named when the server's type differs, and never rewrites it", async () => {
    const served = {
      id: "test.entry",
      fields: {
        title: { type: "string" },
        note: { type: "integer" },
        extra: { type: "string" },
      },
      compatible_with: ["core.note"],
    };
    harness.server.types.set("test.entry", served);
    expect(await harness.once(vendor([entry]))).toBe(1);

    const run = harness.lastRun();
    expect(run.outcome).toBe("failed");
    for (const difference of ['"note"', '"link"', '"extra"', '"title"', "compatible_with"]) {
      expect(run.error).toContain(difference);
    }
    expect(harness.server.rows).toEqual([]);
    expect(harness.server.requestsTo("POST", "/types")).toEqual([]);
    expect(harness.server.requests.some((request) => request.method === "PUT")).toBe(false);
    expect(harness.server.types.get("test.entry")).toBe(served);
  });

  it("stops when the key may not register the type, saying what it lacks", async () => {
    harness.server.refuseNext("POST /types", 403, "forbidden", "Missing metadata.types:write");
    expect(await harness.once(vendor([entry]))).toBe(1);
    expect(harness.lastRun().outcome).toBe("failed");
    expect(harness.lastRun().error).toContain("metadata.types:write");
    expect(harness.server.rows).toEqual([]);
  });
});

describe("--once", () => {
  it("answers 0 for a run that succeeded and 1 for one that failed", async () => {
    expect(await harness.once(vendor([entry]))).toBe(0);
    const failing = vendor([entry]);
    failing.fail = new Error("the vendor answered 500");
    expect(await harness.once(failing)).toBe(1);
    expect(harness.lastRun().outcome).toBe("failed");
  });

  it("answers 1 when the server cannot be reached, having written nothing", async () => {
    harness.server.refuseNext("POST /connectors", 503, "unavailable");
    expect(await harness.once(vendor([entry]))).toBe(1);
    expect(harness.server.rows).toEqual([]);
  });
});
