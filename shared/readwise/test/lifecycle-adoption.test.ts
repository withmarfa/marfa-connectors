import { expect, it } from "vitest";
import { defineConnector } from "../../../kit/src/define.js";
import { start } from "../../../kit/src/main.js";
import { Harness } from "../../../kit/test/harness.js";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import { ReaderIdentities } from "../../../connectors/readwise-reader/src/identity.js";
import { readerPolicy } from "../../../connectors/readwise-reader/src/policy.js";
import { mapHighlight, mapSource } from "../src/mapping.js";
import {
  mapReaderHighlight,
  mapReaderSource,
  readerMutableSourceFields,
  readerMutableHighlightFields,
} from "../src/reader.js";
import {
  sourceFields,
  sourceType,
  highlightFields,
  highlightType,
} from "../src/types.js";
import type { Source } from "../src/export.js";

it("adopts the active highlight alias with production policy and preserves historical rows and agreements", async () => {
  const server = await new ScriptedServer("readwise", {
    types: [sourceType.id, highlightType.id],
    edges: ["references"],
  }).start();
  const harness = new Harness(server);
  server.edgeTypes.set("references", {
    id: "references",
    cardinality: "many-to-many",
    source_type_constraints: ["*"],
    target_type_constraints: ["*"],
    cascade_on_delete: "orphan",
    property_schema: {},
    written_at: "source",
    shipped: true,
  });
  const source: Source = {
    user_book_id: 7,
    source: "reader",
    external_id: "doc",
    is_deleted: false,
    title: "Article",
    highlights: [
      {
        id: 41,
        external_id: "hi",
        text: "Historical passage",
        is_deleted: false,
      },
      { id: 42, external_id: "hi", text: "Active passage", is_deleted: false },
    ],
  };
  const document = {
    id: "hi",
    category: "highlight",
    parent_id: "doc",
    content: "Current Reader passage",
    updated_at: "2026-10-15T00:00:00Z",
  };
  let reader = false;
  const connector = () =>
    defineConnector({
      name: reader ? "readwise-reader" : "readwise",
      source: "readwise",
      env: {},
      connections: [
        {
          id: "references",
          label: "References",
          cardinality: "many-to-many",
          source_type_constraints: [highlightType.id],
          target_type_constraints: [sourceType.id],
        },
      ],
      types: [
        {
          type: sourceType,
          fields: sourceFields,
          readOnly: sourceFields.filter(
            (field) =>
              !(readerMutableSourceFields as readonly string[]).includes(field),
          ),
          policy: (item, entry) =>
            reader
              ? readerPolicy(sourceType.id, "sample", item, entry, true)
              : { owned: true },
        },
        {
          type: highlightType,
          fields: highlightFields,
          readOnly: highlightFields.filter(
            (field) =>
              !(readerMutableHighlightFields as readonly string[]).includes(
                field,
              ),
          ),
          policy: (item, entry) =>
            reader
              ? readerPolicy(highlightType.id, "sample", item, entry, true)
              : { owned: true },
        },
      ],
      async run(context) {
        if (!reader) {
          await context.upsert(sourceType.id, [mapSource("sample", source)]);
          await context.upsert(
            highlightType.id,
            source.highlights.map((h) => mapHighlight("sample", 7, h)),
          );
          return;
        }
        const scope = context.forScope("lifecycle");
        const identities = await ReaderIdentities.load(
          "sample",
          "https://fixture.invalid/",
          context,
          scope.state,
        );
        await identities.prepare(
          {
            page: () =>
              Promise.resolve({
                count: 1,
                results: [source],
                nextPageCursor: null,
              }),
            sourceForHighlight: () => Promise.resolve(undefined),
          },
          1,
        );
        const parent = {
          id: "doc",
          category: "article",
          title: "Article",
          updated_at: "2026-10-15T00:00:00Z",
        };
        const parentIdentity = await identities.resolve(parent);
        await scope.upsert(sourceType.id, [
          mapReaderSource("sample", parent, parentIdentity.enrichment).entry,
        ]);
        const resolved = await identities.resolve(document);
        await scope.upsert(highlightType.id, [
          mapReaderHighlight("sample", document, resolved.enrichment).entry,
        ]);
      },
    });
  try {
    const first = await start(connector(), harness.runtime(["--once"]));
    expect(first, harness.lines.join("\n")).toBe(0);
    server.touch("sample:highlight:42", { note: "", tags: [] });
    const historical = structuredClone(server.row("sample:highlight:41"));
    const active = structuredClone(server.row("sample:highlight:42"));
    const agreements = structuredClone([...server.agreements]);
    const deleted = source.highlights[0];
    if (!deleted) throw new Error("missing historical highlight");
    deleted.is_deleted = true;
    server.keySource = "readwise-reader";
    server.grants = { ...server.grants, sources: ["readwise"] };
    reader = true;
    const code = await start(connector(), harness.runtime(["--once"]));
    expect(code, harness.lines.join("\n")).toBe(0);
    expect(server.rows).toHaveLength(3);
    expect(server.row("sample:highlight:41")).toEqual(historical);
    expect(server.row("sample:highlight:42")).toMatchObject({
      id: active.id,
      source_id: active.source_id,
      properties: {
        canonical_key: "sample:reader-highlight:hi",
        reader_managed: true,
        reader_parent_id: "doc",
        readwise_id: "42",
        readwise_text: "Active passage",
        text: "Current Reader passage",
        note: "",
        tags: [],
      },
    });
    const adopted = structuredClone(server.rows);
    expect(await start(connector(), harness.runtime(["--once"]))).toBe(0);
    expect(server.rows).toEqual(adopted);
    server.keySource = "readwise";
    expect([...server.agreements]).toEqual(agreements);
  } finally {
    await harness.close();
  }
});
