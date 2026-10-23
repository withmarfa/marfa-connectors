import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedRefusal, ScriptedServer } from "./scripted-server.js";

// The scripted server stands in for the pinned server in every other test, so
// each answer here is held to what the pinned server (`vendor/marfa`) gives.

let server: ScriptedServer;
beforeEach(async () => {
  server = await new ScriptedServer("test", { types: ["test.entry"] }).start();
});
afterEach(async () => {
  await server.stop();
});

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${server.key}`,
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

function typed(
  id: string,
  extra: Record<string, unknown> = {},
): [string, Record<string, unknown>] {
  return [id, { id, version: 0, fields: {}, ...extra }];
}

describe("a move between states", () => {
  async function versions(id: string): Promise<number[]> {
    const { body } = await call("GET", `/items/${id}/versions`);
    return (body["data"] as { version: number }[]).map((v) => v.version);
  }

  it("writes no snapshot on a restore or a transition, and one on a write", async () => {
    const row = server.insert("a:1", { title: "One" }, "test.entry");
    server.touch("a:1", { title: "Two" });
    expect(await versions(row.id)).toEqual([1]);

    server.trash(row.id);
    expect((await call("POST", `/items/${row.id}/restore`)).status).toBe(200);
    expect(await versions(row.id)).toEqual([1]);

    for (const state of ["archived", "active"]) {
      const moved = await call("POST", `/items/${row.id}/transition`, {
        state,
      });
      expect(moved.status).toBe(200);
    }
    expect(await versions(row.id)).toEqual([1]);
    expect(row.version).toBe(2);

    // The witness: a write that moves the version does leave one.
    const written = await call("PATCH", `/items/${row.id}`, {
      version: 2,
      properties: { title: "Three" },
    });
    expect(written.status).toBe(200);
    expect(await versions(row.id)).toEqual([1, 2]);
  });
});

describe("a type filter", () => {
  beforeEach(() => {
    for (const [id, type] of [
      typed("test.base"),
      typed("test.base.child"),
      typed("acme.mid", { parent: "test.base" }),
      typed("acme.leaf", { parent: "acme.mid" }),
      typed("test.other"),
    ]) {
      server.types.set(id, type);
      server.insert(`${id}:1`, {}, id);
    }
  });

  const names = (rows: unknown): string[] =>
    (rows as { type: string }[]).map((row) => row.type).sort();

  it("lists a type, every type whose identifier begins with it and a dot, and every type whose chain of parents reaches it", async () => {
    const { body } = await call("GET", "/items?type=test.base");
    expect(names(body["data"])).toEqual([
      "acme.leaf",
      "acme.mid",
      "test.base",
      "test.base.child",
    ]);
  });

  it("lists a type with nothing under it alone", async () => {
    const { body } = await call("GET", "/items?type=test.other");
    expect(names(body["data"])).toEqual(["test.other"]);
  });

  it("does not take a name that only begins with another's characters for its subtree", async () => {
    server.types.set(...typed("test.basement"));
    server.insert("test.basement:1", {}, "test.basement");
    const { body } = await call("GET", "/items?type=test.base");
    expect(names(body["data"])).not.toContain("test.basement");
  });

  it("streams the same subtree it lists", async () => {
    const abort = new AbortController();
    const response = await fetch(`${server.url}/events?type=test.base`, {
      headers: {
        Authorization: `Bearer ${server.key}`,
        "Last-Event-ID": "0",
      },
      signal: abort.signal,
    });
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      text += decoder.decode(chunk, { stream: true });
      if (text.includes("event: stream_live")) break;
    }
    abort.abort();
    const streamed = [...text.matchAll(/"type":"([^"]+)"/g)]
      .map((match) => match[1])
      .sort();
    expect(streamed).toEqual([
      "acme.leaf",
      "acme.mid",
      "test.base",
      "test.base.child",
    ]);
  });
});

describe("a stale update to a link", () => {
  beforeEach(() => {
    server.types.set(...typed("test.entry", { link_field: "vendor_id" }));
  });

  const stale = (id: string, properties: Record<string, unknown>) =>
    call("PATCH", `/items/${id}`, { version: 1, properties });

  it("is judged on the properties it leaves, not on the ones it sent", async () => {
    const mine = server.insert(
      "a:1",
      { vendor_id: "u1", title: "t0" },
      "test.entry",
    );
    // Someone else moves the row's link on, and another row takes the one it
    // left; the stale write only repeats the link it started from.
    server.touch("a:1", { vendor_id: "u9" });
    server.insert("b:1", { vendor_id: "u1" }, "test.entry");

    const answer = await stale(mine.id, { vendor_id: "u1", title: "x" });
    expect(answer.status).toBe(200);
    expect(mine.properties).toEqual({ vendor_id: "u9", title: "x" });
  });

  it("is refused where the properties it leaves take a link another row holds, and lands where none does", async () => {
    const mine = server.insert(
      "c:1",
      { vendor_id: "c1", title: "t0" },
      "test.entry",
    );
    server.touch("c:1", { title: "t1" });
    server.insert("d:1", { vendor_id: "c2" }, "test.entry");

    const refused = await stale(mine.id, { vendor_id: "c2" });
    expect(refused.status).toBe(409);
    expect((refused.body["error"] as { code: string }).code).toBe("link_taken");
    expect(mine.properties["vendor_id"]).toBe("c1");

    const landed = await stale(mine.id, { vendor_id: "c3" });
    expect(landed.status).toBe(200);
    expect(mine.properties).toEqual({ vendor_id: "c3", title: "t1" });
  });
});

describe("a move of an edge's end", () => {
  function kind(id: string, cardinality: string, targets = ["*"]) {
    server.edgeTypes.set(id, {
      id,
      cardinality,
      source_type_constraints: ["*"],
      target_type_constraints: targets,
      cascade_on_delete: "orphan",
      property_schema: {},
    });
  }

  function refusal(move: () => unknown): Record<string, unknown> {
    try {
      move();
    } catch (error) {
      if (!(error instanceof ScriptedRefusal)) throw error;
      return { status: error.status, code: error.code, ...error.details };
    }
    throw new Error("the move was not refused");
  }

  const rows = () =>
    ["a", "b", "c", "d"].map(
      (name) => server.insert(`${name}:1`, {}, "test.entry").id,
    );

  it("refuses an end whose other end may hold many of the type, or both ends at once, and moves nothing", () => {
    const [a = "", b = "", c = "", d = ""] = rows();
    kind("test.many", "many-to-many");
    const many = server.drawEdge(a, b, "test.many");
    for (const end of ["source_id", "target_id"] as const) {
      expect(refusal(() => server.updateEdge(many.id, { [end]: c }))).toEqual({
        status: 400,
        code: "validation_error",
        errors: [{ path: end }],
      });
    }
    const parent = server.drawEdge(a, c, "parent-of");
    expect(
      refusal(() => server.updateEdge(parent.id, { target_id: d })),
    ).toMatchObject({ code: "validation_error" });
    expect(
      refusal(() =>
        server.updateEdge(parent.id, { source_id: b, target_id: d }),
      ),
    ).toMatchObject({ code: "validation_error" });
    kind("test.in", "many-to-one");
    const placed = server.drawEdge(a, b, "test.in");
    expect(
      refusal(() => server.updateEdge(placed.id, { source_id: c })),
    ).toMatchObject({ code: "validation_error" });
    expect(
      server.edges.map((edge) => [edge.source_id, edge.target_id]),
    ).toEqual([
      [a, b],
      [a, c],
      [a, b],
    ]);

    // The witness: the end each type lets move does.
    expect(server.updateEdge(parent.id, { source_id: b }).source_id).toBe(b);
    expect(server.updateEdge(placed.id, { target_id: d }).target_id).toBe(d);
  });

  it("refuses a one-to-one end onto a row that holds one, a target its constraint refuses, a missing row and a self-loop", () => {
    const [a = "", b = "", c = "", d = ""] = rows();
    kind("test.one", "one-to-one");
    const one = server.drawEdge(a, b, "test.one");
    server.drawEdge(c, d, "test.one");
    expect(refusal(() => server.updateEdge(one.id, { target_id: d }))).toEqual({
      status: 400,
      code: "edge_constraint_violation",
      constraint: "cardinality",
      edge_type: "test.one",
      target_id: d,
    });
    expect(
      refusal(() => server.updateEdge(one.id, { source_id: "missing" })),
    ).toMatchObject({ status: 404, code: "item_not_found" });
    expect(
      refusal(() => server.updateEdge(one.id, { source_id: b })),
    ).toMatchObject({ code: "edge_cycle" });
    kind("test.narrow", "many-to-one", ["test.other"]);
    const other = server.insert("e:1", {}, "test.other").id;
    const narrow = server.drawEdge(a, other, "test.narrow");
    expect(
      refusal(() => server.updateEdge(narrow.id, { target_id: b })),
    ).toMatchObject({
      code: "edge_constraint_violation",
      target_type: "test.entry",
    });
    expect(server.updateEdge(one.id, { properties: {} }).target_id).toBe(b);
  });
});

describe("the bulk door", () => {
  const entry = {
    type: "test.entry",
    source_id: "a:1",
    properties: { title: "One" },
  };

  it("refuses an entry of a type the key may not write, and creates it where the key may", async () => {
    server.types.set(...typed("test.entry"));
    server.grants = { type_permissions: { "test.entry": "read" } };
    const refused = await call("POST", "/items/bulk", {
      items: [entry],
      atomic: false,
    });
    expect(refused.body["results"]).toMatchObject([
      { outcome: "errored", error: { code: "type_not_permitted" } },
    ]);
    expect(server.rows).toEqual([]);

    server.grants = { type_permissions: { "test.entry": "write" } };
    const created = await call("POST", "/items/bulk", {
      items: [entry],
      atomic: false,
    });
    expect(created.body["results"]).toMatchObject([{ outcome: "created" }]);
    expect(server.rows).toHaveLength(1);
  });
});
