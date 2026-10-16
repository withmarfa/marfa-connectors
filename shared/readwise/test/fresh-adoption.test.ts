import { expect, it } from "vitest";
import { defineConnector } from "../../../kit/src/define.js";
import { start } from "../../../kit/src/main.js";
import { Harness } from "../../../kit/test/harness.js";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import { ReaderIdentities } from "../../../connectors/readwise-reader/src/identity.js";
import { readerPolicy } from "../../../connectors/readwise-reader/src/policy.js";
import { readerMutableSourceFields } from "../src/reader.js";
import { mapSource } from "../src/mapping.js";
import { mapReaderSource } from "../src/reader.js";
import {
  sourceFields,
  sourceType,
  highlightFields,
  highlightType,
} from "../src/types.js";

it("adopts the current Highlights canonical link through verified identity evidence", async () => {
  const server = await new ScriptedServer("readwise", {
    types: [sourceType.id, highlightType.id],
  }).start();
  const harness = new Harness(server);
  const source = {
    user_book_id: 7,
    source: "reader",
    external_id: "doc",
    title: "Article",
    highlights: [],
  };
  const document = {
    id: "doc",
    category: "article",
    title: "Article",
    location: "new",
    notes: "Reader note",
    tags: { remote: { name: "remote" } },
    updated_at: "2026-10-15T00:00:00Z",
  };
  let reader = false;
  const connector = () =>
    defineConnector({
      name: reader ? "readwise-reader" : "readwise",
      source: "readwise",
      env: {},
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
        { type: highlightType, fields: highlightFields },
      ],
      async run(context) {
        if (!reader) {
          await context.upsert(sourceType.id, [mapSource("sample", source)]);
          return;
        }
        const scope = context.forScope("adoption");
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
        const resolved = await identities.resolve(document);
        await scope.upsert(sourceType.id, [
          mapReaderSource("sample", document, resolved.enrichment).entry,
        ]);
        expect(await scope.state.checkpoint("adopted", true)).toEqual({
          committed: true,
        });
      },
    });
  try {
    expect(await start(connector(), harness.runtime(["--once"]))).toBe(0);
    server.touch("sample:source:7", {
      title: "Local title",
      notes: "",
      tags: [],
    });
    const before = structuredClone(server.row("sample:source:7"));
    const highlightsAgreements = structuredClone([...server.agreements]);
    server.keySource = "readwise-reader";
    server.grants = { ...server.grants, sources: ["readwise"] };
    reader = true;
    const result = await start(connector(), harness.runtime(["--once"]));
    expect(result, harness.lines.join("\n")).toBe(0);
    expect(server.rows).toHaveLength(1);
    expect(server.row("sample:source:7")).toMatchObject({
      id: before.id,
      source_id: before.source_id,
      properties: {
        canonical_key: "sample:reader-document:doc",
        reader_managed: true,
        category: "article",
        reader_location: "new",
        title: "Local title",
        notes: "",
        tags: [],
      },
    });
    const adopted = structuredClone(server.row("sample:source:7"));
    expect(await start(connector(), harness.runtime(["--once"]))).toBe(0);
    expect(server.row("sample:source:7")).toEqual(adopted);
    server.keySource = "readwise";
    expect([...server.agreements]).toEqual(highlightsAgreements);
  } finally {
    await harness.close();
  }
});
