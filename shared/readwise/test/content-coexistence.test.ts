import { expect, it } from "vitest";
import { defineConnector, type Entry } from "../../../kit/src/define.js";
import { start } from "../../../kit/src/main.js";
import { Harness } from "../../../kit/test/harness.js";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import {
  readerFileFields,
  readerFilePolicy,
  readerFileType,
} from "../src/content-types.js";
import { drainContent } from "../src/content-queue.js";
import { contentQueue, digest, enqueueContent } from "../src/content.js";
import type { ReaderDocument } from "../src/reader.js";
import { sourceFields, sourceType } from "../src/types.js";

it.each(["same bytes", "changed bytes"])(
  "keeps shared files stable across independent connector restarts with %s",
  async (change) => {
    const server = await new ScriptedServer("readwise", {
      types: [sourceType.id, readerFileType.id],
      edges: ["attached-to"],
    }).start();
    const harness = new Harness(server);
    const canonical = "sample:reader-document:one";
    const fileId = `${canonical}:content:html`;
    let incoming: Entry | undefined;
    let loads = 0;
    let lookups = 0;
    let document: ReaderDocument;
    function file(revision: string, text: string): Entry {
      document = {
        id: "one",
        category: "article",
        updated_at: revision,
        html_content: text,
      };
      const key = digest(text);
      return {
        source_id: fileId,
        properties: {
          canonical_key: fileId,
          account: "sample",
          document_key: canonical,
          resource_kind: "html",
          reader_revision: revision,
          content_key: key,
          title: "Reader html",
        },
        file: {
          key,
          load: () => {
            loads++;
            return Promise.resolve({
              bytes: new TextEncoder().encode(text),
              mime_type: "text/html; charset=utf-8",
            });
          },
        },
        connections: {
          "attached-to": [{ type: sourceType.id, id: canonical }],
        },
      };
    }
    async function once(source: string) {
      server.keySource = source;
      server.grants = {
        sources: ["readwise"],
        type_permissions: {
          [sourceType.id]: "write",
          [readerFileType.id]: "write",
        },
        edge_permissions: { "attached-to": "write" },
      };
      const connector = defineConnector({
        name: source,
        source: "readwise",
        env: {},
        types: [
          { type: sourceType, fields: sourceFields },
          {
            type: readerFileType,
            fields: readerFileFields,
            policy: (item, entry) => readerFilePolicy("sample", item, entry),
          },
        ],
        connections: [
          {
            id: "attached-to",
            cardinality: "many-to-many",
            source_type_constraints: [readerFileType.id],
            target_type_constraints: [sourceType.id],
          },
        ],
        async run(context) {
          await context.upsert(sourceType.id, [
            {
              source_id: canonical,
              properties: {
                canonical_key: canonical,
                account: "sample",
                title: "Article",
              },
            },
          ]);
          if (incoming) await context.upsert(readerFileType.id, [incoming]);
          const state = context.forScope("content-queue").state;
          await enqueueContent(state, [
            {
              id: document.id,
              type: sourceType.id,
              canonical,
              revision: digest(JSON.stringify(document)),
            },
          ]);
          await drainContent(
            context,
            {
              page: () => {
                lookups++;
                return Promise.resolve({
                  results: [document],
                  count: 1,
                  nextPageCursor: null,
                });
              },
              document: () => Promise.resolve(document),
            },
            state,
          );
          expect(contentQueue(state)).toEqual([]);
        },
      });
      expect(await start(connector, harness.runtime(["--once"]))).toBe(0);
    }
    try {
      incoming = file("2026-01-01T00:00:00Z", "<html>first</html>");
      await once("readwise-reader");
      const latest =
        change === "same bytes" ? "<html>first</html>" : "<html>second</html>";
      incoming = file("2026-01-02T00:00:00Z", latest);
      await once("readwise");
      const snapshot = structuredClone(server.row(fileId));
      const edges = structuredClone(server.edges);
      const uploads = server.uploads;
      const priorLoads = loads;
      const priorLookups = lookups;
      const allFiles = structuredClone(
        server.rows.filter((row) => row.type === readerFileType.id),
      );
      incoming = undefined;
      for (let pass = 0; pass < 2; pass++) {
        await once("readwise-reader");
        expect(server.row(fileId)).toEqual(snapshot);
        await once("readwise");
        expect(server.row(fileId)).toEqual(snapshot);
      }
      expect(server.edges).toEqual(edges);
      expect([server.uploads, loads]).toEqual([uploads, priorLoads]);
      expect(lookups).toBe(priorLookups);
      expect(
        server.rows.filter((row) => row.type === readerFileType.id),
      ).toEqual(allFiles);
      expect(server.row(fileId).properties).toMatchObject({
        reader_revision: "2026-01-02T00:00:00Z",
        content_key: digest(latest),
        blob_ref: `sha256:${digest(latest)}`,
      });
      // Fresh preservation must still replace a newer value held by its peer.
      incoming = file("2026-01-03T00:00:00Z", "<html>third</html>");
      await once("readwise-reader");
      expect(server.row(fileId).properties).toMatchObject({
        reader_revision: "2026-01-03T00:00:00Z",
        content_key: digest("<html>third</html>"),
        blob_ref: `sha256:${digest("<html>third</html>")}`,
      });
      incoming = undefined;
      await once("readwise");
      const fresh = structuredClone(server.row(fileId));
      await once("readwise-reader");
      await once("readwise");
      expect(server.row(fileId)).toEqual(fresh);
      server.touch(fileId, { title: "Local retained file title" });
      const local = structuredClone(server.row(fileId));
      await once("readwise-reader");
      await once("readwise");
      expect(server.row(fileId)).toEqual(local);
    } finally {
      await harness.close();
    }
  },
);
