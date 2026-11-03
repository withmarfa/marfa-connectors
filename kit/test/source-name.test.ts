import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineConnector } from "../src/define.js";
import { start } from "../src/main.js";
import { Harness, linkedType, testFields } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

function named(declared: { sourceName?: string; sourceMark?: string }) {
  return defineConnector({
    name: "test",
    source: "test",
    ...declared,
    types: [{ type: linkedType, fields: testFields }],
    env: { TEST_TOKEN: "secret" },
    run() {
      return Promise.resolve();
    },
  });
}

const patches = (): { query: string | null; body: unknown }[] =>
  harness.server.requestsTo("PATCH", "/source").map((request) => ({
    query: request.query.get("source"),
    body: request.body,
  }));

describe("a connector's source name and mark", () => {
  it("sets the declared name and mark on its source once, at start", async () => {
    const connector = named({
      sourceName: "Test Vendor",
      sourceMark: "simple-icons:github",
    });
    expect(await start(connector, harness.runtime(["--once"]))).toBe(0);
    expect(patches()).toEqual([
      {
        query: "test",
        body: { name: "Test Vendor", mark: "simple-icons:github" },
      },
    ]);
    expect(harness.server.sourceNames.get("test")).toEqual({
      name: "Test Vendor",
      mark: "simple-icons:github",
    });
  });

  it("sends nothing where the connector declares neither", async () => {
    expect(await start(named({}), harness.runtime(["--once"]))).toBe(0);
    expect(harness.server.requestsTo("GET", "/source")).toHaveLength(0);
    expect(patches()).toEqual([]);
  });

  it("sets a name alone when it declares no mark, and leaves the mark unsent", async () => {
    await start(
      named({ sourceName: "Test Vendor" }),
      harness.runtime(["--once"]),
    );
    expect(patches()).toEqual([
      { query: "test", body: { name: "Test Vendor" } },
    ]);
  });

  it("keeps a name or mark the owner has set, and sends only what is missing", async () => {
    harness.server.sourceNames.set("test", { name: "My vendor" });
    const connector = named({
      sourceName: "Test Vendor",
      sourceMark: "simple-icons:github",
    });
    await start(connector, harness.runtime(["--once"]));
    expect(patches()).toEqual([
      { query: "test", body: { mark: "simple-icons:github" } },
    ]);
    expect(harness.server.sourceNames.get("test")).toEqual({
      name: "My vendor",
      mark: "simple-icons:github",
    });
    await start(connector, harness.runtime(["--once"]));
    expect(patches()).toHaveLength(1);
  });

  it("still syncs, and says so, when the server refuses the name or mark", async () => {
    harness.server.refuseNext(
      "PATCH /source",
      400,
      "invalid_schema",
      "mark is not an icon",
    );
    const connector = named({
      sourceName: "Test Vendor",
      sourceMark: "simple-icons:nothing",
    });
    expect(await start(connector, harness.runtime(["--once"]))).toBe(0);
    expect(
      harness.lines.some(
        (line) =>
          line.includes("source") &&
          line.includes("invalid_schema") &&
          line.includes("next start"),
      ),
    ).toBe(true);
    expect(harness.server.runs.at(-1)?.outcome).toBe("succeeded");
  });

  it("does not swallow an unreachable server: the start tries again", async () => {
    harness.server.refuseNext("PATCH /source", 503, "unavailable");
    const connector = named({ sourceName: "Test Vendor" });
    expect(await start(connector, harness.runtime(["--once"]))).toBe(1);
    expect(harness.server.sourceNames.get("test")).toBeUndefined();
  });

  it("warns and still syncs when the server refuses to read the source", async () => {
    harness.server.refuseNext("GET /source", 404, "source_not_found");
    expect(
      await start(
        named({ sourceName: "Test Vendor" }),
        harness.runtime(["--once"]),
      ),
    ).toBe(0);
    expect(patches()).toEqual([]);
    expect(
      harness.lines.some((line) => line.includes("source_not_found")),
    ).toBe(true);
  });

  it("does not swallow a key the server refuses", async () => {
    harness.server.refuseNext("GET /source", 401, "unauthorized");
    expect(
      await start(
        named({ sourceName: "Test Vendor" }),
        harness.runtime(["--once"]),
      ),
    ).toBe(1);
    expect(patches()).toEqual([]);
  });
});
