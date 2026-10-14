import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { MarfaClient } from "@withmarfa/client";
import { check } from "./check.js";
import {
  ConnectorUnderProof,
  registeredAsKindOf,
  rowsOf,
  typeHeld,
  type Item,
} from "./connector.js";

export async function proveReadwise(
  marfa: MarfaClient,
  url: string,
): Promise<void> {
  const passage = "A complete passage 漢字\n".repeat(300);
  const highlight = {
    id: 42,
    text: passage,
    note: "A personal annotation",
    is_deleted: false,
    updated_at: new Date().toISOString(),
    highlighted_at: new Date().toISOString(),
    location: 17,
    location_type: "time_offset",
    color: "yellow",
    tags: ["reading"],
  };
  const book = {
    user_book_id: 42,
    title: "A source",
    source: "reader",
    external_id: "reader-document-42",
    highlights: [highlight],
  };
  const vendor = createServer((request, response) => {
    if (
      request.method !== "GET" ||
      request.headers.authorization !== "Token readwise-proof-token"
    ) {
      response.writeHead(401).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({ count: 1, nextPageCursor: null, results: [book] }),
    );
  });
  await new Promise<void>((done) => vendor.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${String((vendor.address() as AddressInfo).port)}/`;
  try {
    let key = "";
    await check(
      "readwise: its key writes only its two types, references and type metadata",
      async () => {
        const { data, error } = await marfa.POST("/keys", {
          body: {
            label: "readwise",
            source: "readwise",
            default_tier: "feed",
            type_permissions: {
              "readwise.source": "write",
              "readwise.highlight": "write",
            },
            edge_permissions: { references: "write" },
            metadata_permissions: { types: "write" },
          },
        });
        if (data === undefined)
          throw new Error(`Readwise key was refused: ${JSON.stringify(error)}`);
        key = data.key;
        if (
          data.source !== "readwise" ||
          data.default_tier !== "feed" ||
          Object.keys(data.metadata_permissions).join() !== "types" ||
          Object.keys(data.edge_permissions).join() !== "references"
        )
          throw new Error(
            "Readwise key permissions differ from the requested scope",
          );
        return "scoped readwise key, with no edge-type registration permission";
      },
    );
    const runner = new ConnectorUnderProof("readwise", url, key, {
      READWISE_ACCOUNT: "proof",
      READWISE_ACCESS_TOKEN: "readwise-proof-token",
      READWISE_API_URL: base,
    });
    const once = async (): Promise<void> => {
      const result = await runner.once();
      if (result.code !== 0)
        throw new Error(`Readwise run failed: ${result.output}`);
    };
    const all = async (): Promise<Map<string, Item>> =>
      new Map([
        ...(await rowsOf(marfa, "readwise.source", "readwise")),
        ...(await rowsOf(marfa, "readwise.highlight", "readwise")),
      ]);
    const row = async (key: string): Promise<Item> => {
      const found = (await all()).get(key);
      if (found === undefined) throw new Error(`Readwise row ${key} missing`);
      return found;
    };
    const sourceHeld = await typeHeld(marfa, "readwise.source");
    const highlightHeld = await typeHeld(marfa, "readwise.highlight");
    await check(
      "readwise: full passages inherit core types and reference their source",
      async () => {
        await once();
        const source = await row("proof:source:42");
        const imported = await row("proof:highlight:42");
        await registeredAsKindOf(
          marfa,
          "readwise.source",
          "core.media",
          sourceHeld,
          [source],
        );
        await registeredAsKindOf(
          marfa,
          "readwise.highlight",
          "core.highlight",
          highlightHeld,
          [imported],
        );
        if (
          imported.properties["text"] !== passage ||
          imported.properties["note"] !== highlight.note ||
          imported.properties["locator_type"] !== "time" ||
          source.properties["external_id"] !== book.external_id
        )
          throw new Error(
            "Readwise fields differ from the complete vendor record",
          );
        const { data, error } = await marfa.GET("/items/{id}/edges", {
          params: {
            path: { id: imported.id },
            query: { edge_type: "references" },
          },
        });
        if (data === undefined)
          throw new Error(
            `Readwise edges could not be read: ${JSON.stringify(error)}`,
          );
        if (
          !data.data.some(
            (edge) =>
              edge.source_id === imported.id && edge.target_id === source.id,
          )
        )
          throw new Error(
            "Readwise highlight has no canonical source reference",
          );
        return "two feed rows with distinct identities, full text and canonical reference";
      },
    );
    await check(
      "readwise: an unchanged export changes neither imported rows nor edges",
      async () => {
        const before = await all();
        const imported = await row("proof:highlight:42");
        const edges = await marfa.GET("/items/{id}/edges", {
          params: {
            path: { id: imported.id },
            query: { edge_type: "references" },
          },
        });
        if (edges.data === undefined)
          throw new Error("Readwise edge snapshot failed");
        await once();
        if (JSON.stringify([...before]) !== JSON.stringify([...(await all())]))
          throw new Error("An unchanged export changed imported rows");
        const after = await marfa.GET("/items/{id}/edges", {
          params: {
            path: { id: imported.id },
            query: { edge_type: "references" },
          },
        });
        if (
          after.data === undefined ||
          JSON.stringify(after.data) !== JSON.stringify(edges.data)
        )
          throw new Error("An unchanged export changed references");
        return "identical item and reference snapshots";
      },
    );
    await check(
      "readwise: explicit deletion archives a highlight without erasing its text",
      async () => {
        highlight.is_deleted = true;
        await once();
        const imported = await row("proof:highlight:42");
        if (
          imported.state !== "archived" ||
          imported.properties["text"] !== passage
        )
          throw new Error("Readwise deletion lost content or did not archive");
        return "archived highlight retains its full passage";
      },
    );
    await check(
      "readwise: an upstream restoration returns the imported highlight",
      async () => {
        highlight.is_deleted = false;
        await once();
        if ((await row("proof:highlight:42")).state !== "active")
          throw new Error("Readwise restoration left its highlight archived");
        return "the same highlight is active again";
      },
    );
    await check(
      "readwise: invalid credentials fail without changing imported content",
      async () => {
        const before = await all();
        const failed = await runner.run(["--once"], {
          READWISE_ACCESS_TOKEN: "readwise-wrong-token",
        });
        if (failed.code === 0 || !failed.output.includes("401"))
          throw new Error("Readwise authentication failure was not reported");
        if (JSON.stringify([...before]) !== JSON.stringify([...(await all())]))
          throw new Error(
            "Readwise authentication failure changed imported rows",
          );
        return "HTTP 401 reported and imported rows unchanged";
      },
    );
  } finally {
    vendor.closeAllConnections();
    await new Promise<void>((done) =>
      vendor.close(() => {
        done();
      }),
    );
  }
}
