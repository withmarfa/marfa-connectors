import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { start } from "../src/main.js";
import {
  Harness,
  secretToken,
  testConnector,
  testType,
  vendor,
} from "./harness.js";

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

    const required = ["MARFA_URL", "MARFA_KEY", "TEST_TOKEN"];
    for (const name of required) {
      harness.lines.length = 0;
      expect(await harness.once(vendor([entry]), { [name]: undefined })).toBe(
        2,
      );
      expect(harness.lines.join("\n")).toContain(
        `cannot start without ${name} in the environment`,
      );
    }
    harness.lines.length = 0;
    const code = await harness.once(
      vendor([entry]),
      Object.fromEntries(required.map((name) => [name, " "])),
    );
    expect(code).toBe(2);
    expect(harness.lines.join("\n")).toContain(
      `cannot start without ${required.join(", ")} in the environment`,
    );
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
    for (const argv of [
      [],
      ["--every"],
      ["--every", "soon"],
      ["--once", "--every", "1m"],
    ]) {
      expect(await start(testConnector(vendor()), harness.runtime(argv))).toBe(
        2,
      );
    }
    expect(harness.server.requests).toEqual([]);
    expect(
      await start(testConnector(vendor()), harness.runtime(["--once"])),
    ).toBe(0);
    expect(harness.server.requests.length).toBeGreaterThan(0);
  });

  it("refuses a source under a reserved prefix", async () => {
    const connector = { ...testConnector(vendor()), source: "Connector:test" };
    expect(await start(connector, harness.runtime(["--once"]))).toBe(2);
    expect(harness.server.requests).toEqual([]);
    expect(
      await start(testConnector(vendor()), harness.runtime(["--once"])),
    ).toBe(0);
    expect(harness.server.requests.length).toBeGreaterThan(0);
  });

  it("refuses a MARFA_URL it cannot use, without showing what it holds", async () => {
    const pasted = "marfa_k1_pasted_into_the_wrong_variable";
    expect(await harness.once(vendor(), { MARFA_URL: pasted })).toBe(2);
    expect(
      await harness.once(vendor(), { MARFA_URL: "ftp://marfa.example.com" }),
    ).toBe(2);
    const said = harness.lines.join("\n");
    expect(said).toContain("MARFA_URL");
    expect(said).not.toContain(pasted);
    expect(harness.server.requests).toEqual([]);
    expect(await harness.once(vendor())).toBe(0);
    expect(harness.server.requests.length).toBeGreaterThan(0);
  });

  it("refuses a secret too short to keep out of the logs", async () => {
    expect(await harness.once(vendor(), { TEST_TOKEN: "abcdefg" })).toBe(2);
    expect(harness.lines.join("\n")).toContain("TEST_TOKEN");
    expect(harness.server.requests).toEqual([]);
    expect(await harness.once(vendor(), { TEST_TOKEN: "abcdefgh" })).toBe(0);
    expect(harness.server.requests.length).toBeGreaterThan(0);
  });

  it("refuses an environment the connector's own check refuses, under either schedule", async () => {
    const connector = {
      ...testConnector(vendor([entry])),
      checkEnv: (env: {
        TEST_REGION: string | undefined;
        TEST_TOKEN: string;
      }) => {
        if (env.TEST_REGION === "nowhere") {
          throw new Error(`no region nowhere for ${env.TEST_TOKEN}`);
        }
      },
    };
    for (const argv of [["--once"], ["--every", "1m"]]) {
      expect(
        await start(
          connector,
          harness.runtime(argv, { TEST_REGION: "nowhere" }),
        ),
      ).toBe(2);
    }
    const said = harness.lines.join("\n");
    expect(said).toContain("no region nowhere for [redacted]");
    expect(said).not.toContain(secretToken);
    expect(harness.server.requests).toEqual([]);
    expect(await start(connector, harness.runtime(["--once"]))).toBe(0);
    expect(harness.server.rows).toHaveLength(1);
  });

  it("waits on a check that answers later, and refuses what it refuses", async () => {
    const connector = {
      ...testConnector(vendor([entry])),
      checkEnv: async () => {
        await Promise.resolve();
        throw new Error("the region is refused");
      },
    };
    expect(await start(connector, harness.runtime(["--once"]))).toBe(2);
    expect(harness.lines.join("\n")).toContain("the region is refused");
    expect(harness.server.requests).toEqual([]);
  });

  it("starts no run once told to stop while registering", async () => {
    const held = vendor([entry]);
    harness.server.beforeAnswer = (request) => {
      if (request.path === "/connectors") harness.stop();
    };
    expect(await harness.once(held)).toBe(0);
    expect(held.runs).toBe(0);
    expect(harness.server.runs).toEqual([]);

    harness.server.beforeAnswer = undefined;
    expect(await harness.once(held)).toBe(0);
    expect(held.runs).toBe(1);
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

describe("the key check on start", () => {
  it("starts on a key holding read and write on its own type and the registration of it", async () => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write" },
      metadata_permissions: { types: "write" },
    };
    expect(await harness.once(vendor([entry]))).toBe(0);
    expect(harness.server.requestsTo("GET", "/keys/current")).toHaveLength(1);
    expect(harness.server.rows).toHaveLength(1);
  });

  it("refuses a key wider than its type, naming the key and what is too wide, before it registers the type or writes a row", async () => {
    harness.server.grants = {
      permissions: ["keys.mint", "items.purge"],
      type_permissions: { "test.entry": "write", "core.note": "read" },
      metadata_permissions: { types: "write", tags: "write" },
      edge_permissions: { "*": "write" },
    };
    expect(await harness.once(vendor([entry]))).toBe(1);
    const error = harness.lastRun().error ?? "";
    expect(harness.lastRun().outcome).toBe("failed");
    for (const named of [
      "keys.mint",
      "items.purge",
      "type core.note=read",
      "metadata tags=write",
      "edge *=write",
    ]) {
      expect(error).toContain(named);
    }
    expect(error).not.toContain("type test.entry");
    expect(harness.server.rows).toEqual([]);
    expect(harness.server.requestsTo("POST", "/types")).toEqual([]);
  });

  it("refuses a pattern over every type, the operator key, and any extension or profile reach, naming each", async () => {
    for (const [grants, named] of [
      [{ type_permissions: { "*": "write" } }, "type *=write"],
      [{ is_operator: true }, "it is the operator key"],
      [{ extension_permissions: { "app.x": "read" } }, "extension app.x=read"],
      [{ profile_permissions: { email: "read" } }, "profile email=read"],
    ] as const) {
      harness.server.grants = grants;
      expect(await harness.once(vendor([entry]))).toBe(1);
      expect(harness.lastRun().error).toContain(named);
      expect(harness.lastRun().error).toContain("key-1");
      expect(harness.server.rows).toEqual([]);
    }
  });

  it("starts on a key that claims sources besides its own, as a second account's does", async () => {
    harness.server.grants = {
      sources: ["test"],
      type_permissions: { "test.entry": "write" },
    };
    expect(await harness.once(vendor([entry]))).toBe(0);
  });

  it("stops on a server with no door for a key to read itself, saying so", async () => {
    harness.server.refuseNext(
      "GET /keys/current",
      404,
      "not_found",
      "Not found",
    );
    expect(await harness.once(vendor([entry]))).toBe(1);
    expect(harness.lastRun().outcome).toBe("failed");
    expect(harness.lastRun().error).toContain("GET /keys/current");
    expect(harness.server.rows).toEqual([]);
  });

  it("reads a level of none as holding nothing", async () => {
    harness.server.grants = {
      type_permissions: { "test.entry": "write", "core.note": "none" },
    };
    expect(await harness.once(vendor([entry]))).toBe(0);
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
        vendor_id: { type: "string" },
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
      fields: {
        title: { type: "string" },
        note: { type: "string" },
        link: { type: "url" },
        vendor_id: { type: "string" },
      },
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
    for (const difference of [
      '"note"',
      '"link"',
      '"extra"',
      '"title"',
      "compatible_with",
    ]) {
      expect(run.error).toContain(difference);
    }
    expect(harness.server.rows).toEqual([]);
    expect(harness.server.requestsTo("POST", "/types")).toEqual([]);
    expect(
      harness.server.requests.some((request) => request.method === "PUT"),
    ).toBe(false);
    expect(harness.server.types.get("test.entry")).toBe(served);
  });

  it("stops when the key may not register the type, saying what it lacks", async () => {
    harness.server.refuseNext(
      "POST /types",
      403,
      "forbidden",
      "Missing metadata.types:write",
    );
    expect(await harness.once(vendor([entry]))).toBe(1);
    expect(harness.lastRun().outcome).toBe("failed");
    expect(harness.lastRun().error).toContain("metadata.types:write");
    expect(harness.server.rows).toEqual([]);
  });

  it("carries on when another process registered the same type first", async () => {
    harness.server.beforeAnswer = (request) => {
      if (request.method === "POST" && request.path === "/types") {
        harness.server.types.set("test.entry", testType);
      }
    };
    expect(await harness.once(vendor([entry]))).toBe(0);
    expect(harness.server.rows).toHaveLength(1);
  });

  it("stops when another process registered a different type first", async () => {
    harness.server.beforeAnswer = (request) => {
      if (request.method === "POST" && request.path === "/types") {
        harness.server.types.set("test.entry", {
          id: "test.entry",
          fields: { title: { type: "integer" } },
        });
      }
    };
    expect(await harness.once(vendor([entry]))).toBe(1);
    expect(harness.lastRun().error).toContain('field "title" has type');
    expect(harness.server.rows).toEqual([]);
  });

  it("reads a format that is a field type of its own as that type", async () => {
    const connector = testConnector(vendor([entry]));
    const carried = {
      ...connector,
      type: {
        ...testType,
        fields: {
          title: { type: "string" as const, required: true },
          note: { type: "string" as const },
          link: { type: "string" as const, format: "url" as const },
          vendor_id: { type: "string" as const },
        },
      },
    };
    harness.server.types.set("test.entry", testType);
    expect(await start(carried, harness.runtime(["--once"]))).toBe(0);
    expect(harness.server.rows).toHaveLength(1);
  });

  it("takes the fields the server answers from a parent as the parent's", async () => {
    harness.server.types.set("test.base", {
      id: "test.base",
      fields: { origin: { type: "string", required: true } },
    });
    harness.server.types.set("test.entry", {
      ...testType,
      parent: "test.base",
      fields: {
        ...testType.fields,
        origin: { type: "string", required: true },
      },
    });
    const connector = testConnector(vendor([entry]));
    const child = { ...connector, type: { ...testType, parent: "test.base" } };
    expect(await start(child, harness.runtime(["--once"]))).toBe(0);
    expect(harness.server.rows).toHaveLength(1);
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
