import { createClient } from "@withmarfa/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Marfa } from "../src/marfa.js";
import { Harness, secretToken, vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

it("retains prior and redacted new problems separately at checkpoint, failure and restart", async () => {
  harness.server.problems.set("test", { prior: "previous failure" });
  const held = vendor();
  held.conditions = [["new", `failed ${secretToken}`]];
  held.read = async (context) => {
    expect(await context.forScope("A").state.checkpoint("A", 1)).toEqual({
      committed: true,
    });
    throw new Error("B failed");
  };
  expect(await harness.once(held)).toBe(1);
  const expected = { prior: "previous failure", new: "failed [redacted]" };
  expect(harness.problems()).toEqual(expected);
  const writes = harness.server.requestsTo(
    "PUT",
    "/connectors/connector-1/state",
  );
  expect(writes).toHaveLength(2);
  for (const request of writes) {
    const body = request.body as { state: object; problems: object };
    expect(body.problems).toEqual(expected);
    expect(body.state).not.toHaveProperty("conditions");
  }
  held.conditions = [];
  held.unreached = { keys: ["prior", "new"] };
  held.read = (context) => {
    expect(context.state.get("A")).toBe(1);
    return Promise.resolve();
  };
  expect(await harness.once(held)).toBe(0);
  expect(harness.problems()).toEqual(expected);
  expect(harness.kept()).not.toHaveProperty("conditions");
  delete held.unreached;
  expect(await harness.once(held)).toBe(0);
  expect(harness.problems()).toEqual({});
  expect(harness.lines.join("\n")).toContain("cleared");
});

it("raises and clears prototype-named problems through the actual lifecycle", async () => {
  const held = vendor();
  held.conditions = [
    ["__proto__", "prototype problem"],
    ["toString", "string problem"],
  ];
  expect(await harness.once(held)).toBe(0);
  expect(harness.problems()).toEqual(Object.fromEntries(held.conditions));
  held.conditions = [];
  held.unreached = { keys: ["__proto__", "toString"] };
  expect(await harness.once(held)).toBe(0);
  expect(Object.keys(harness.problems()).sort()).toEqual([
    "__proto__",
    "toString",
  ]);
  delete held.unreached;
  expect(await harness.once(held)).toBe(0);
  expect(harness.problems()).toEqual({});
});

it("detaches both request members and validates the acknowledgement against captured intent", async () => {
  const marfa = new Marfa(() =>
    createClient({
      baseUrl: harness.server.url,
      credential: harness.server.key,
    }),
  );
  harness.server.holder = {
    process: "snapshot",
    until: Number.MAX_SAFE_INTEGER,
  };
  const state = { page: { number: 1 } };
  const problems = { vendor: "standing" };
  harness.server.beforeAnswer = (request) => {
    if (request.method === "PUT" && request.path.endsWith("/state")) {
      state.page.number = 2;
      problems.vendor = "changed locally";
    }
  };
  await marfa.putConnectorState("connector-1", "snapshot", state, problems);
  expect(harness.kept()).toEqual({ page: { number: 1 } });
  expect(harness.problems()).toEqual({ vendor: "standing" });
});

it("loads only explicit problems and removes obsolete private conditions on save", async () => {
  harness.server.states.set("test", {
    state: { progress: 1 },
    conditions: { obsolete: "old private failure" },
  });
  harness.server.problems.set("test", { current: "explicit failure" });
  const held = vendor();
  held.unreached = { keys: ["current", "obsolete"] };
  expect(await harness.once(held)).toBe(0);
  expect(harness.problems()).toEqual({ current: "explicit failure" });
  expect(harness.kept()).not.toHaveProperty("conditions");
  expect(harness.kept()["state"]).toEqual({ progress: 1 });
});

it.each([
  { state: { state: { A: 1 } } },
  { state: { state: { A: 1 } }, problems: [] },
  { state: { state: { A: 1 } }, problems: { other: "different" } },
  { state: { wrong: true }, problems: { problem: "standing" } },
])(
  "fences both snapshots after malformed acknowledgement %j",
  async (answer) => {
    const held = vendor();
    held.conditions = [["problem", "standing"]];
    held.read = async (context) => {
      harness.server.stateAnswer = { value: answer };
      await expect(
        context.forScope("A").state.checkpoint("A", 1),
      ).rejects.toThrow("invalid state acknowledgment");
      await expect(
        context.forScope("B").state.checkpoint("B", 2),
      ).rejects.toThrow();
    };
    expect(await harness.once(held)).toBe(1);
    expect(harness.kept()["state"]).toEqual({ A: 1 });
    expect(harness.problems()).toEqual({ problem: "standing" });
    expect(
      harness.server.requestsTo("PUT", "/connectors/connector-1/state"),
    ).toHaveLength(1);
    expect(harness.lines.join("\n")).not.toContain("cleared");
  },
);

it("applies both members after a lost answer and sends no later stale write", async () => {
  const held = vendor();
  held.conditions = [["problem", "standing"]];
  held.read = async (context) => {
    harness.server.loseStateAnswer = true;
    await context.forScope("A").state.checkpoint("A", 1);
  };
  expect(await harness.once(held)).toBe(1);
  expect(harness.problems()).toEqual({ problem: "standing" });
  expect(harness.kept()["state"]).toEqual({ A: 1 });
  expect(
    harness.server.requestsTo("PUT", "/connectors/connector-1/state"),
  ).toHaveLength(1);
});

it("leaves both members untouched after a definite refusal", async () => {
  harness.server.states.set("test", { state: { old: 1 } });
  harness.server.problems.set("test", { prior: "standing" });
  const held = vendor();
  held.conditions = [["new", "new failure"]];
  harness.server.refuseNext(
    "PUT /connectors/connector-1/state",
    400,
    "validation_error",
  );
  expect(await harness.once(held)).toBe(1);
  expect(harness.kept()).toEqual({ state: { old: 1 } });
  expect(harness.problems()).toEqual({ prior: "standing" });
});

it("validates independent UTF-8 snapshots, UTF-16 messages, count and opaque keys atomically", async () => {
  const client = createClient({
    baseUrl: harness.server.url,
    credential: harness.server.key,
  });
  harness.server.holder = { process: "proof", until: Number.MAX_SAFE_INTEGER };
  const write = (
    state: Record<string, unknown>,
    problems: Record<string, string>,
  ) =>
    client.PUT("/connectors/{id}/state", {
      params: { path: { id: "connector-1" } },
      body: { process: "proof", state, problems },
    });
  const fullState = {
    payload: "x".repeat(
      512 * 1024 - Buffer.byteLength(JSON.stringify({ payload: "" })),
    ),
  };
  const keyLength = 512 * 1024 - Buffer.byteLength(JSON.stringify({ "": "x" }));
  const fullProblems = { ["k".repeat(keyLength)]: "x" };
  expect((await write(fullState, fullProblems)).response.status).toBe(200);
  expect(Buffer.byteLength(JSON.stringify(harness.kept()))).toBe(512 * 1024);
  expect(Buffer.byteLength(JSON.stringify(harness.problems()))).toBe(
    512 * 1024,
  );
  for (const [state, problems] of [
    [{ payload: fullState.payload + "x" }, fullProblems],
    [fullState, { ["k".repeat(keyLength + 1)]: "x" }],
    [fullState, { ["é".repeat(Math.floor(keyLength / 2) + 1)]: "x" }],
    [
      fullState,
      Object.fromEntries(
        Array.from({ length: 201 }, (_, i) => [String(i), "x"]),
      ),
    ],
    [fullState, { problem: "x".repeat(501) }],
    [fullState, { problem: "😀".repeat(251) }],
  ] as const) {
    expect((await write(state, problems)).response.status).toBe(400);
    expect(harness.kept()).toEqual(fullState);
    expect(harness.problems()).toEqual(fullProblems);
  }
  const accepted = Object.fromEntries(
    Array.from({ length: 198 }, (_, i) => [String(i), "x"]),
  );
  Object.defineProperty(accepted, "__proto__", {
    value: "😀".repeat(250),
    enumerable: true,
  });
  Object.defineProperty(accepted, "toString", {
    value: "x".repeat(500),
    enumerable: true,
  });
  expect((await write({}, accepted)).response.status).toBe(200);
  expect(harness.problems()).toEqual(accepted);
  expect(Object.hasOwn(harness.problems(), "__proto__")).toBe(true);
  expect(
    (
      await client.PUT("/connectors/{id}/state", {
        params: { path: { id: "connector-1" } },
        body: { process: "proof", state: { kept: true } },
      })
    ).response.status,
  ).toBe(200);
  expect(harness.problems()).toEqual(accepted);
  expect((await write({}, {})).response.status).toBe(200);
  expect(harness.problems()).toEqual({});
});

it("renews the hold and fences stale holders across expiry and registration deletion", async () => {
  const client = createClient({
    baseUrl: harness.server.url,
    credential: harness.server.key,
  });
  const path = { path: { id: "connector-1" } };
  const hold = (process: string) =>
    client.POST("/connectors/{id}/hold", { params: path, body: { process } });
  const write = (process: string, number: number) =>
    client.PUT("/connectors/{id}/state", {
      params: path,
      body: {
        process,
        state: { number },
        problems: { failure: String(number) },
      },
    });
  expect((await hold("old")).response.status).toBe(200);
  expect((await write("old", 1)).response.status).toBe(200);
  harness.server.advance(harness.server.holdMs - 1000);
  expect((await hold("old")).data?.renewed).toBe(true);
  harness.server.advance(1001);
  expect((await write("old", 2)).response.status).toBe(200);
  harness.server.advance(harness.server.holdMs);
  expect((await write("old", 3)).response.status).toBe(409);
  expect((await hold("successor")).response.status).toBe(200);
  expect((await write("successor", 4)).response.status).toBe(200);
  expect((await write("old", 5)).response.status).toBe(409);
  expect(harness.kept()).toEqual({ number: 4 });
  expect(harness.problems()).toEqual({ failure: "4" });
  expect(
    (await client.GET("/connectors/{id}", { params: path })).data?.problems,
  ).toEqual({ failure: "4" });
  expect(
    (await client.DELETE("/connectors/{id}", { params: path })).response.status,
  ).toBe(200);
  expect((await write("successor", 6)).response.status).toBe(404);
  const registered = await client.POST("/connectors", {
    body: { name: "replacement" },
  });
  expect(registered.data?.problems).toEqual({ failure: "4" });
  expect((await write("successor", 7)).response.status).toBe(409);
  expect((await hold("replacement")).response.status).toBe(200);
  expect((await write("replacement", 8)).response.status).toBe(200);
  expect(
    (await client.DELETE("/connectors/{id}/state", { params: path })).response
      .status,
  ).toBe(200);
  expect(harness.kept()).toEqual({});
  expect(harness.problems()).toEqual({});
});
