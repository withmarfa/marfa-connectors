import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createClient,
  type MarfaClient,
  type components,
} from "@withmarfa/client";
import { check } from "./check.js";
import {
  ConnectorUnderProof,
  registration,
  rowsOf,
  type Item,
} from "./connector.js";
import type { ProofServer } from "./server.js";
import { readerVendor } from "./readwise-reader-stub.js";

export async function proveReadwiseReader(
  admin: MarfaClient,
  url: string,
  mint: ProofServer["mintKey"],
  updateKey: ProofServer["updateKey"],
): Promise<void> {
  const vendor = await readerVendor();
  const failures: unknown[] = [];
  const verify = async (name: string, observe: () => Promise<string>) => {
    try {
      await check(name, observe);
    } catch (error) {
      failures.push(error);
    }
  };
  try {
    const key = (source: string, legacy = false) =>
      mint({
        label: source,
        source,
        sources: ["readwise"],
        default_tier: "feed",
        type_permissions: {
          "readwise.source": "write",
          "readwise.highlight": "write",
          ...(!legacy && { "readwise.file": "write" as const }),
        },
        edge_permissions: {
          references: "write",
          ...(!legacy && { "attached-to": "write" as const }),
        },
        metadata_permissions: { types: "write" },
        permissions: [],
        extension_permissions: {},
        profile_permissions: {},
      });
    const highlightsKey = await key("reader-proof-highlights", true);
    const readerKey = await key("reader-proof-reader");
    const options = (account: string) => ({
      READWISE_ACCOUNT: account,
      READWISE_ACCESS_TOKEN: "reader-fixture-token",
      READWISE_API_URL: `${vendor.base}/v2/`,
      READWISE_READER_API_URL: `${vendor.base}/v3/`,
    });
    const highlights = new ConnectorUnderProof(
      "readwise",
      url,
      highlightsKey.key,
      options("adoption"),
    );
    const reader = new ConnectorUnderProof(
      "readwise-reader",
      url,
      readerKey.key,
      options("adoption"),
    );
    const once = async (runner: ConnectorUnderProof) => {
      const result = await runner.once();
      if (result.code !== 0) {
        for (const heldKey of [highlightsKey, readerKey]) {
          const client = createClient({
            baseUrl: url,
            credential: heldKey.key,
          });
          const found = await registration(client, heldKey.id);
          const snapshot = await client.GET("/connectors/{id}/state", {
            params: { path: { id: found.id } },
          });
          console.error(
            "fixture failure conditions",
            JSON.stringify(snapshot.data?.problems),
          );
        }
      }
      assert.equal(result.code, 0, result.output);
    };
    const all = async () =>
      new Map([
        ...(await rowsOf(admin, "readwise.source", "readwise")),
        ...(await rowsOf(admin, "readwise.highlight", "readwise")),
      ]);
    const row = async (natural: string): Promise<Item> => {
      const value = (await all()).get(natural);
      assert.ok(value, `Missing ${natural}`);
      return value;
    };
    const patch = async (item: Item, properties: Record<string, unknown>) => {
      const result = await admin.PATCH("/items/{id}", {
        params: { path: { id: item.id } },
        body: { version: item.version, properties },
      });
      assert.ok(result.data, JSON.stringify(result.error));
      return result.data;
    };
    const transition = async (item: Item, state: "archived" | "trashed") => {
      const result = await admin.POST("/items/{id}/transition", {
        params: { path: { id: item.id } },
        body: { state },
      });
      assert.ok(result.data, JSON.stringify(result.error));
    };
    const stamp = new Date().toISOString();
    for (let index = 1; index <= 4; index++) {
      vendor.sources.push({
        user_book_id: index,
        source: "reader",
        external_id: `doc-${String(index)}`,
        title: `Export title ${String(index)}`,
        highlights: [
          {
            id: index + 10,
            external_id: `hi-${String(index)}`,
            text: `Export passage ${String(index)}`,
            note: "Export annotation",
          },
        ],
      });
      vendor.documents.set(`doc-${String(index)}`, {
        id: `doc-${String(index)}`,
        category: "article",
        title: `Reader title ${String(index)}`,
        location: "new",
        html_content: `<article><p>Full retained HTML ${String(index)} 漢字</p></article>`,
        updated_at: stamp,
      });
      vendor.documents.set(`hi-${String(index)}`, {
        id: `hi-${String(index)}`,
        category: "highlight",
        parent_id: `doc-${String(index)}`,
        content: `Reader passage ${String(index)}`,
        notes: "Reader annotation",
        tags: { retained: { name: "retained" } },
        updated_at: stamp,
      });
    }
    const legacy = new ConnectorUnderProof(
      "readwise",
      url,
      highlightsKey.key,
      { ...options("adoption"), PROOF_VENDOR_URL: vendor.base },
      resolve(import.meta.dirname, "readwise-reader-legacy.js"),
    );
    let before = new Map<string, Item>();
    await verify(
      "reader fixture: legacy export rows and agreements survive explicit structural schema replacement",
      async () => {
        await once(legacy);
        before = await all();
        assert.equal(before.size, 8);
        await transition(await row("adoption:source:2"), "archived");
        await transition(await row("adoption:source:3"), "trashed");
        await transition(await row("adoption:highlight:14"), "trashed");
        const purged = await admin.POST("/items/{id}/purge", {
          params: { path: { id: (await row("adoption:highlight:14")).id } },
        });
        assert.ok(purged.response.ok, JSON.stringify(purged.error));
        const oldClient = createClient({
          baseUrl: url,
          credential: highlightsKey.key,
        });
        const registered = await registration(oldClient, highlightsKey.id);
        const state = () =>
          oldClient.GET("/connectors/{id}/state", {
            params: { path: { id: registered.id } },
          });
        const agreements = await state();
        assert.ok(agreements.data, JSON.stringify(agreements.error));
        const refused = await reader.once();
        assert.equal(
          refused.code,
          1,
          "Old required export ID must refuse Reader schema adoption",
        );
        assert.match(
          refused.output,
          /readwise_id|required|schema|incompatible/i,
        );
        const retained = await all();
        for (const type of ["source", "highlight"]) {
          const definition = JSON.parse(
            await readFile(
              resolve(
                import.meta.dirname,
                `../../../shared/readwise/src/readwise.${type}.json`,
              ),
              "utf8",
            ),
          ) as components["schemas"]["TypeDefinitionInput"];
          const replaced = await admin.PUT("/types/{id}", {
            params: { path: { id: `readwise.${type}` } },
            body: definition,
          });
          assert.ok(replaced.data, JSON.stringify(replaced.error));
        }
        await updateKey(highlightsKey.id, {
          type_permissions: {
            "readwise.source": "write",
            "readwise.highlight": "write",
            "readwise.file": "write",
          },
          edge_permissions: { references: "write", "attached-to": "write" },
        });
        assert.deepEqual(await all(), retained);
        assert.deepEqual((await state()).data, agreements.data);
        return "real legacy process, required-ID refusal, operator PUT, unchanged rows and saved agreements";
      },
    );
    await verify(
      "reader fixture: Highlights-first adoption retains natural IDs in every state and respects purged aliases",
      async () => {
        await once(reader);
        for (const [natural, item] of await all())
          assert.equal(item.id, before.get(natural)?.id);
        assert.equal(
          (await row("adoption:source:1")).properties["canonical_key"],
          "adoption:reader-document:doc-1",
        );
        assert.equal(
          (await row("adoption:highlight:11")).properties["text"],
          "Reader passage 1",
        );
        assert.equal(
          (await row("adoption:highlight:11")).properties["readwise_text"],
          "Export passage 1",
        );
        assert.equal((await row("adoption:source:2")).state, "archived");
        assert.equal((await row("adoption:source:3")).state, "trashed");
        assert.equal((await all()).has("adoption:highlight:14"), false);
        assert.equal(
          [...(await all()).values()].some(
            (item) => item.properties["reader_id"] === "hi-4",
          ),
          false,
        );
        assert.equal(vendor.writes.length, 0, JSON.stringify(vendor.writes));
        return "same row IDs, preserved archived/trash states, no resurrection or vendor writes";
      },
    );
    await verify(
      "reader fixture: unchanged processes preserve row, file and edge versions",
      async () => {
        await once(reader);
        await once(highlights);
        await once(reader);
        const snapshot = async () => {
          const items = [
            ...(await all()).values(),
            ...(await rowsOf(admin, "readwise.file", "readwise")).values(),
          ].sort((a, b) => a.id.localeCompare(b.id));
          const edges = [];
          for (const item of items) {
            const result = await admin.GET("/items/{id}/edges", {
              params: { path: { id: item.id } },
            });
            assert.ok(result.data, JSON.stringify(result.error));
            edges.push(result.data);
          }
          return { items, edges };
        };
        const stable = await snapshot();
        await once(reader);
        await once(highlights);
        assert.deepEqual(await snapshot(), stable);
        return "complete item and edge snapshots unchanged after both fresh processes";
      },
    );
    await verify(
      "reader fixture: oversized differing export text and folded annotations are retained as exact blob bytes",
      async () => {
        const source = vendor.sources[0];
        assert.ok(source?.highlights[0]);
        const passage = "Different export passage 漢字\n".repeat(5000);
        const note = "Long annotation 漢字\n".repeat(6000);
        source.highlights[0].text = passage;
        vendor.documents.set("large-note", {
          id: "large-note",
          category: "note",
          parent_id: "hi-1",
          content: note,
        });
        await once(reader);
        const files = [
          ...(await rowsOf(admin, "readwise.file", "readwise")).values(),
        ];
        for (const [field, expected] of [
          ["readwise_text", passage],
          ["reader_notes", note],
        ] as const) {
          const file = files.find((item) =>
            item.source_id?.startsWith(
              `adoption:reader-highlight:hi-1:text:${field}:`,
            ),
          );
          assert.ok(file, `Missing retained ${field} file`);
          const result = await admin.GET("/blobs/{hash}", {
            params: { path: { hash: String(file.properties["blob_ref"]) } },
            parseAs: "arrayBuffer",
          });
          assert.ok(result.data, JSON.stringify(result.error));
          const text = Buffer.from(result.data).toString();
          if (field === "readwise_text") assert.equal(text, expected);
          else assert.ok(text.includes(JSON.stringify(expected).slice(1, -1)));
        }
        assert.equal(
          (await row("adoption:highlight:11")).properties["text"],
          "Reader passage 1",
        );
        assert.ok(
          Array.isArray(
            (await row("adoption:highlight:11")).properties[
              "reader_text_files"
            ],
          ),
        );
        return "Reader passage stays canonical; full export and note metadata bytes are downloadable files";
      },
    );
    await verify(
      "reader fixture: Highlights independently refreshes managed Reader fields and preserves pending edits",
      async () => {
        const writesBefore = vendor.writes.length;
        const document = vendor.documents.get("doc-1");
        assert.ok(document);
        document.title = "Remote title while Reader stopped";
        await once(highlights);
        assert.equal(
          (await row("adoption:source:1")).properties["title"],
          document.title,
        );
        await patch(await row("adoption:source:1"), {
          title: "Pending local title",
        });
        document.title = "New remote title";
        await once(highlights);
        assert.equal(
          (await row("adoption:source:1")).properties["title"],
          "Pending local title",
        );
        assert.equal(
          vendor.writes.length,
          writesBefore,
          JSON.stringify(vendor.writes),
        );
        await once(reader);
        assert.equal(document.title, "Pending local title");
        assert.equal(
          (await row("adoption:source:1")).properties["canonical_key"],
          "adoption:reader-document:doc-1",
        );
        return "Reader GET from Highlights, pending title retained, one owning Reader carries it later";
      },
    );
    await verify(
      "reader fixture: clearing annotations reaches Reader and uncertain updates reconcile without duplicate writes",
      async () => {
        const highlight = await row("adoption:highlight:11");
        await patch(highlight, { note: "", tags: [] });
        await once(reader);
        assert.equal(vendor.documents.get("hi-1")?.notes, "");
        assert.deepEqual(vendor.documents.get("hi-1")?.tags, {});
        const document = vendor.documents.get("doc-1");
        assert.ok(document);
        await patch(await row("adoption:source:1"), {
          title: "Uncertain acknowledged title",
        });
        vendor.uncertain();
        await reader.once();
        const count = vendor.writes.length;
        assert.equal(document.title, "Uncertain acknowledged title");
        await once(reader);
        assert.equal(vendor.writes.length, count);
        assert.equal(
          (await row("adoption:source:1")).properties["title"],
          document.title,
        );
        return "explicit empty annotation and committed-response-loss recovered by GET, no second write";
      },
    );
    await verify(
      "reader fixture: retained HTML survives upstream disappearance, archive and housekeeping",
      async () => {
        const files = [
          ...(await rowsOf(admin, "readwise.file", "readwise")).values(),
        ];
        const html = files.find(
          (item) =>
            item.properties["document_key"] ===
              "adoption:reader-document:doc-1" &&
            item.properties["resource_kind"] === "html",
        );
        assert.ok(html);
        const hash = html.properties["blob_ref"];
        assert.equal(typeof hash, "string");
        const bytes = async () => {
          const result = await admin.GET("/blobs/{hash}", {
            params: { path: { hash: String(hash) } },
            parseAs: "arrayBuffer",
          });
          assert.ok(result.data, JSON.stringify(result.error));
          return Buffer.from(result.data);
        };
        const content = await bytes();
        assert.equal(
          content.toString(),
          "<article><p>Full retained HTML 1 漢字</p></article>",
        );
        vendor.documents.delete("doc-1");
        vendor.documents.delete("hi-1");
        const reconciliationKey = await key("reader-proof-reconciliation");
        await once(
          new ConnectorUnderProof(
            "readwise-reader",
            url,
            reconciliationKey.key,
            options("adoption"),
          ),
        );
        assert.equal((await row("adoption:source:1")).state, "archived");
        assert.equal((await row("adoption:highlight:11")).state, "archived");
        const maintenance = await mint({
          label: "Reader proof maintenance",
          source: "reader-proof-maintenance",
          permissions: ["instance.maintain"],
          type_permissions: {},
          edge_permissions: {},
          metadata_permissions: {},
          extension_permissions: {},
          profile_permissions: {},
        });
        const maintainer = createClient({
          baseUrl: url,
          credential: maintenance.key,
        });
        for (const name of [
          "version-thinning",
          "blob-orphans",
          "blob-orphans",
        ]) {
          const result = await maintainer.POST("/housekeeping/{name}/run", {
            params: { path: { name } },
          });
          assert.ok(result.data, JSON.stringify(result.error));
          assert.notEqual(
            result.data.outcome,
            "failed",
            JSON.stringify(result.data),
          );
        }
        assert.deepEqual(await bytes(), content);
        return "actual blob bytes remain downloadable after complete/direct absence reconciliation and blob jobs";
      },
    );
    await verify(
      "reader fixture: Reader-alone import and later export IDs preserve Reader-first identity",
      async () => {
        vendor.sources.length = 0;
        vendor.documents.clear();
        vendor.documents.set("solo", {
          id: "solo",
          category: "article",
          title: "Reader only",
          location: "new",
          html_content: "<p>Reader alone</p>",
        });
        vendor.documents.set("solo-highlight", {
          id: "solo-highlight",
          category: "highlight",
          parent_id: "solo",
          content: "Reader-only passage",
        });
        const firstKey = await key("reader-proof-first");
        const laterKey = await key("reader-proof-later-highlights");
        const first = new ConnectorUnderProof(
          "readwise-reader",
          url,
          firstKey.key,
          options("reader-first"),
        );
        const later = new ConnectorUnderProof(
          "readwise",
          url,
          laterKey.key,
          options("reader-first"),
        );
        await once(first);
        const source = await row("reader-first:reader-document:solo");
        const highlight = await row(
          "reader-first:reader-highlight:solo-highlight",
        );
        assert.equal(source.properties["readwise_id"], undefined);
        assert.equal(highlight.properties["readwise_id"], undefined);
        vendor.sources.push({
          user_book_id: 90,
          source: "reader",
          external_id: "solo",
          title: "Export title",
          highlights: [
            {
              id: 91,
              external_id: "solo-highlight",
              text: "Different export text",
            },
          ],
        });
        await once(later);
        assert.equal(
          (await row("reader-first:reader-document:solo")).id,
          source.id,
        );
        assert.equal(
          (await row("reader-first:reader-highlight:solo-highlight")).id,
          highlight.id,
        );
        assert.equal(
          (await row("reader-first:reader-highlight:solo-highlight"))
            .properties["text"],
          "Reader-only passage",
        );
        assert.equal(
          (await row("reader-first:reader-highlight:solo-highlight"))
            .properties["readwise_id"],
          "91",
        );
        assert.equal((await all()).has("reader-first:highlight:91"), false);
        return "no fabricated numeric IDs; delayed export enriches the original two rows";
      },
    );
    await verify(
      "reader fixture: explicit source creation recovers response loss without a duplicate save",
      async () => {
        vendor.sources.length = 0;
        vendor.documents.clear();
        const createKey = await key("reader-proof-create");
        const creating = new ConnectorUnderProof(
          "readwise-reader",
          url,
          createKey.key,
          options("creation"),
        );
        await once(creating);
        const created = await admin.POST("/items", {
          body: {
            type: "readwise.source",
            properties: {
              account: "creation",
              title: "Explicit saved title",
              url: "https://example.com/reader-proof",
              reader_create: true,
            },
          },
        });
        assert.ok(created.data, JSON.stringify(created.error));
        vendor.uncertain();
        await creating.once();
        const saves = vendor.writes.filter(
          (write) => write.path === "/v3/save/",
        ).length;
        assert.equal(saves, 1);
        await once(creating);
        assert.equal(
          vendor.writes.filter((write) => write.path === "/v3/save/").length,
          saves,
        );
        const updated = await admin.GET("/items/{id}", {
          params: { path: { id: created.data.item.id } },
        });
        assert.ok(updated.data, JSON.stringify(updated.error));
        assert.equal(
          updated.data.item.properties["canonical_key"],
          "creation:reader-document:created",
          JSON.stringify({
            local: updated.data.item,
            imported: [...(await all()).values()].filter(
              (item) => item.properties["account"] === "creation",
            ),
            writes: vendor.writes.filter(
              (write) =>
                write.path.includes("created") || write.path.includes("save"),
            ),
          }),
        );
        assert.equal(
          vendor.documents.get("created")?.title,
          "Explicit saved title",
        );
        return "explicit opt-in, one save across response loss, same local row linked to the verified Reader result";
      },
    );
    await verify(
      "reader fixture: complete inventories above the deletion cap archive nothing",
      async () => {
        vendor.sources.length = 0;
        vendor.documents.clear();
        for (let index = 0; index < 21; index++)
          vendor.documents.set(`guard-${String(index)}`, {
            id: `guard-${String(index)}`,
            category: "article",
            title: "Deletion guard",
          });
        const initialKey = await key("reader-proof-guard-initial");
        await once(
          new ConnectorUnderProof(
            "readwise-reader",
            url,
            initialKey.key,
            options("guard"),
          ),
        );
        const expected = [...(await all()).values()].filter(
          (item) => item.properties["account"] === "guard",
        );
        assert.equal(expected.length, 21);
        vendor.documents.clear();
        const missingKey = await key("reader-proof-guard-missing");
        await once(
          new ConnectorUnderProof(
            "readwise-reader",
            url,
            missingKey.key,
            options("guard"),
          ),
        );
        for (const item of (await all()).values())
          if (item.properties["account"] === "guard")
            assert.equal(item.state, "active");
        return "21 confirmed direct absences, zero archives; smaller-set witness passed earlier";
      },
    );
    await verify(
      "reader fixture: current Highlights-first adoption keeps IDs, content and repeated runs stable",
      async () => {
        vendor.sources.length = 0;
        vendor.documents.clear();
        const html = "<article>Fresh current installation 漢字</article>";
        vendor.sources.push({
          user_book_id: 91,
          source: "reader",
          external_id: "fresh-doc",
          title: "Fresh article",
          highlights: [
            { id: 92, external_id: "fresh-hi", text: "Fresh passage" },
          ],
        });
        vendor.documents.set("fresh-doc", {
          id: "fresh-doc",
          category: "article",
          title: "Fresh article",
          location: "new",
          html_content: html,
          updated_at: stamp,
        });
        vendor.documents.set("fresh-hi", {
          id: "fresh-hi",
          category: "highlight",
          parent_id: "fresh-doc",
          content: "Fresh passage",
          updated_at: stamp,
        });
        const freshHighlightsKey = await key("reader-proof-fresh-highlights");
        const freshReaderKey = await key("reader-proof-fresh-reader");
        const freshHighlights = new ConnectorUnderProof(
          "readwise",
          url,
          freshHighlightsKey.key,
          options("fresh"),
        );
        const freshReader = new ConnectorUnderProof(
          "readwise-reader",
          url,
          freshReaderKey.key,
          { ...options("fresh"), READWISE_READER_INBOUND_ONLY: "true" },
        );
        const freshRows = async () =>
          new Map(
            [...(await all())].filter(
              ([, item]) => item.properties["account"] === "fresh",
            ),
          );
        await once(freshHighlights);
        const original = await freshRows();
        assert.equal(original.size, 2);
        for (const [natural, item] of original)
          assert.equal(item.properties["canonical_key"], natural);
        await once(freshReader);
        const adopted = await freshRows();
        assert.equal(adopted.size, 2);
        for (const [natural, item] of adopted) {
          assert.equal(item.id, original.get(natural)?.id);
          assert.equal(item.source_id, natural);
          assert.equal(item.properties["reader_managed"], true);
        }
        const snapshot = async () => ({
          items: await freshRows(),
          files: [...(await rowsOf(admin, "readwise.file", "readwise"))].filter(
            ([, item]) => item.properties["account"] === "fresh",
          ),
        });
        const retained = await snapshot();
        const file = retained.files.find(
          ([, item]) => item.properties["resource_kind"] === "html",
        )?.[1];
        assert.ok(file);
        const content = await admin.GET("/blobs/{hash}", {
          params: { path: { hash: String(file.properties["blob_ref"]) } },
          parseAs: "arrayBuffer",
        });
        assert.ok(content.data, JSON.stringify(content.error));
        assert.equal(Buffer.from(content.data).toString(), html);
        await once(freshHighlights);
        await once(freshReader);
        assert.deepEqual(await snapshot(), retained);
        return "current binaries, original IDs and natural keys, retained HTML, unchanged item and file versions";
      },
    );
    await verify(
      "reader fixture: unique active highlight alias preserves historical rows and content",
      async () => {
        vendor.sources.length = 0;
        vendor.documents.clear();
        const html = "<article>Lifecycle preservation 漢字</article>";
        const source = {
          user_book_id: 101,
          source: "reader",
          external_id: "lifecycle-doc",
          title: "Lifecycle article",
          is_deleted: false,
          highlights: [
            {
              id: 102,
              external_id: "lifecycle-hi",
              text: "Historical passage",
              is_deleted: false,
            },
            {
              id: 103,
              external_id: "lifecycle-hi",
              text: "Active passage",
              is_deleted: false,
            },
          ],
        };
        vendor.sources.push(source);
        vendor.documents.set("lifecycle-doc", {
          id: "lifecycle-doc",
          category: "article",
          title: "Lifecycle article",
          location: "new",
          html_content: html,
          updated_at: stamp,
        });
        vendor.documents.set("lifecycle-hi", {
          id: "lifecycle-hi",
          category: "highlight",
          parent_id: "lifecycle-doc",
          content: "Current Reader passage",
          updated_at: stamp,
        });
        const highlightsKey = await key("reader-proof-lifecycle-highlights");
        const readerKey = await key("reader-proof-lifecycle-reader");
        const highlights = new ConnectorUnderProof(
          "readwise",
          url,
          highlightsKey.key,
          options("lifecycle"),
        );
        const reader = new ConnectorUnderProof(
          "readwise-reader",
          url,
          readerKey.key,
          { ...options("lifecycle"), READWISE_READER_INBOUND_ONLY: "true" },
        );
        await once(highlights);
        const historical = await row("lifecycle:highlight:102");
        const active = await row("lifecycle:highlight:103");
        const old = source.highlights[0];
        assert.ok(old);
        old.is_deleted = true;
        const writes = vendor.writes.length;
        await once(reader);
        assert.deepEqual(await row("lifecycle:highlight:102"), historical);
        const adopted = await row("lifecycle:highlight:103");
        assert.equal(adopted.id, active.id);
        assert.equal(adopted.source_id, active.source_id);
        assert.equal(adopted.properties["readwise_id"], "103");
        assert.equal(
          adopted.properties["canonical_key"],
          "lifecycle:reader-highlight:lifecycle-hi",
        );
        assert.equal(adopted.properties["text"], "Current Reader passage");
        assert.equal(adopted.properties["readwise_text"], "Active passage");
        const snapshot = async () => ({
          items: [...(await all())].filter(
            ([, item]) => item.properties["account"] === "lifecycle",
          ),
          files: [...(await rowsOf(admin, "readwise.file", "readwise"))].filter(
            ([, item]) => item.properties["account"] === "lifecycle",
          ),
        });
        const retained = await snapshot();
        assert.equal(retained.items.length, 3);
        const file = retained.files.find(
          ([, item]) => item.properties["resource_kind"] === "html",
        )?.[1];
        assert.ok(file);
        const blob = await admin.GET("/blobs/{hash}", {
          params: { path: { hash: String(file.properties["blob_ref"]) } },
          parseAs: "arrayBuffer",
        });
        assert.ok(blob.data);
        assert.equal(Buffer.from(blob.data).toString(), html);
        await once(reader);
        assert.deepEqual(await snapshot(), retained);
        assert.equal(vendor.writes.length, writes);
        return "active row ID retained, historical row untouched, export passage and HTML retained, exact unchanged versions, zero provider writes";
      },
    );
    if (failures.length)
      throw new AggregateError(
        failures,
        `${String(failures.length)} Reader fixture statements failed`,
      );
  } finally {
    await vendor.close();
  }
}
