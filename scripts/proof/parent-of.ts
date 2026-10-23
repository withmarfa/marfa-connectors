import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createClient, type MarfaClient } from "@withmarfa/client";
import { check } from "./check.js";
import { ConnectorUnderProof, restore, rowsOf, trash } from "./connector.js";
import type { ProofServer } from "./server.js";

type Events = [string, string?][];

async function edgesFrom(marfa: MarfaClient, id: string) {
  const { data, error } = await marfa.GET("/items/{id}/edges", {
    params: { path: { id }, query: { edge_type: "parent-of" } },
  });
  assert.ok(data, JSON.stringify(error));
  return data.data;
}

export async function proveParentOf(
  url: string,
  mintKey: ProofServer["mintKey"],
): Promise<void> {
  await check(
    "a connector writes the instance's own parent-of from its exceptions' side, and a trash of a series in Marfa is carried once with its exceptions",
    async () => {
      const source = "proof-parent-of",
        type = "proof.parent.event";
      const key = await mintKey({
        label: "parent-of proof",
        source,
        type_permissions: { [type]: "write" },
        edge_permissions: { "parent-of": "write" },
        metadata_permissions: { types: "write" },
        default_tier: "feed",
      });
      const marfa = createClient({ baseUrl: url, credential: key.key });
      const directory = await mkdtemp(join(tmpdir(), "proof-parent-of-"));
      const journal = join(directory, "journal");
      await writeFile(journal, "");
      try {
        const runner = new ConnectorUnderProof(
          source,
          url,
          key.key,
          { PROOF_JOURNAL: journal },
          resolve(import.meta.dirname, "parent-of-connector.js"),
        );
        const run = async (events: Events) => {
          const result = await runner.run(["--once"], {
            PROOF_EVENTS: JSON.stringify(events),
          });
          assert.equal(result.code, 0, result.output);
          return result.output;
        };
        const carried = async () =>
          (await readFile(journal, "utf8"))
            .split("\n")
            .filter((line) => line !== "")
            .map(
              (line) =>
                JSON.parse(line) as {
                  kind: string;
                  event: string;
                  added: string[];
                  removed: string[];
                },
            );
        const rows = async () => rowsOf(marfa, type, source);
        const seriesOf = async (id: string) => {
          const { data, error } = await marfa.GET("/items/{id}/backrefs", {
            params: { path: { id }, query: { edge_type: "parent-of" } },
          });
          assert.ok(data, JSON.stringify(error));
          return data.data.map((edge) => edge.source_id);
        };

        // The exceptions come before the series that they name.
        const events: Events = [
          ["e1", "s"],
          ["e2", "s"],
          ["plain"],
          ["s"],
          ["t"],
        ];
        await run(events);
        let held = await rows();
        const id = (name: string) => {
          const row = held.get(name);
          assert.ok(row, `${name} was not written`);
          return row.id;
        };
        assert.deepEqual(
          (await edgesFrom(marfa, id("s")))
            .map((edge) => edge.target_id)
            .sort(),
          [id("e1"), id("e2")].sort(),
        );
        assert.deepEqual(await seriesOf(id("e1")), [id("s")]);
        assert.deepEqual(await seriesOf(id("plain")), []);

        // A second run changes nothing, and carries nothing back.
        const before = [...held.values()].map((row) => row.version);
        await run(events);
        held = await rows();
        assert.deepEqual(
          [...held.values()].map((row) => row.version),
          before,
        );
        assert.deepEqual(await carried(), []);

        // An exception moves to another series, and the first is let go.
        await run([["e1", "t"], ["e2", "s"], ["plain"], ["s"], ["t"]]);
        assert.deepEqual(await seriesOf(id("e1")), [id("t")]);
        assert.deepEqual(await seriesOf(id("e2")), [id("s")]);
        assert.deepEqual(await carried(), []);

        // A person removes one in Marfa: it is carried as the series removed.
        const edge = (await edgesFrom(marfa, id("s")))[0];
        assert.ok(edge);
        const removed = await marfa.DELETE("/edges/{id}", {
          params: { path: { id: edge.id } },
        });
        assert.ok(removed.response.ok, JSON.stringify(removed.error));
        await run([["e1", "t"], ["e2", "s"], ["plain"], ["s"], ["t"]]);
        assert.deepEqual(await carried(), [
          { kind: "updated", event: "e2", added: [], removed: ["s"] },
        ]);

        // The series is trashed in Marfa, and the instance takes its
        // exceptions with it: one trash is carried, and none of theirs.
        await trash(marfa, id("t"));
        assert.equal((await rows()).get("e1")?.state, "trashed");
        await run([["e1", "t"], ["e2", "s"], ["plain"], ["s"], ["t"]]);
        assert.deepEqual((await carried()).slice(1), [
          { kind: "trashed", event: "t", added: [], removed: [] },
        ]);

        // Restoring the series brings its exceptions back, carried as one
        // restore.
        await restore(marfa, id("t"));
        assert.equal((await rows()).get("e1")?.state, "active");
        await run([["e1", "t"], ["e2", "s"], ["plain"], ["s"], ["t"]]);
        assert.deepEqual((await carried()).slice(2), [
          { kind: "restored", event: "t", added: [], removed: [] },
        ]);
        assert.deepEqual(await seriesOf(id("e1")), [id("t")]);

        // A calendar of many exceptions is read through one listing of the
        // edge type, not a request for each row, and finds the same edges.
        const base: Events = [
          ["e1", "t"],
          ["e2", "s"],
          ["plain"],
          ["s"],
          ["t"],
        ];
        const many: Events = [
          ...base,
          ...Array.from({ length: 12 }, (_, at): [string, string] => [
            `x${String(at)}`,
            "u",
          ]),
          ["u"],
        ];
        await run(many);
        held = await rows();
        for (let at = 0; at < 12; at += 1) {
          assert.deepEqual(await seriesOf(id(`x${String(at)}`)), [id("u")]);
        }
        const settled = [...held.values()].map((row) => row.version);
        await run(many);
        held = await rows();
        assert.deepEqual(
          [...held.values()].map((row) => row.version),
          settled,
        );
        assert.equal((await carried()).length, 3);
        // Edges the connector's key may not read, or reads only from one end,
        // are left as they are: a note joined to a note, and the series joined
        // to a note.
        const outsider = createClient({
          baseUrl: url,
          credential: (
            await mintKey({
              label: "parent-of proof outsider",
              source: "proof-parent-of-person",
              type_permissions: { [type]: "write", "core.note": "write" },
              edge_permissions: { "parent-of": "write" },
              default_tier: "feed",
            })
          ).key,
        });
        const notes: string[] = [];
        for (const title of ["First note", "Second note"]) {
          const made = await outsider.POST("/items", {
            body: { type: "core.note", properties: { title, body: title } },
          });
          assert.ok(made.data, JSON.stringify(made.error));
          notes.push(made.data.item.id);
        }
        const [first, second] = notes;
        assert.ok(first && second);
        for (const [source, target] of [
          [first, second],
          [id("u"), first],
        ] as const) {
          const joined = await outsider.POST("/edges", {
            body: {
              source_id: source,
              target_id: target,
              edge_type: "parent-of",
            },
          });
          assert.ok(joined.data, JSON.stringify(joined.error));
        }
        const gone = (await edgesFrom(marfa, id("u"))).find(
          (edge) => edge.target_id === id("x0"),
        );
        assert.ok(gone);
        const dropped = await marfa.DELETE("/edges/{id}", {
          params: { path: { id: gone.id } },
        });
        assert.ok(dropped.response.ok, JSON.stringify(dropped.error));
        await run(many);
        assert.deepEqual((await carried()).slice(3), [
          { kind: "updated", event: "x0", added: [], removed: ["u"] },
        ]);
        assert.deepEqual(
          (await edgesFrom(outsider, id("u")))
            .map((edge) => edge.target_id)
            .filter((target) => target === first),
          [first],
        );
        assert.deepEqual(
          (await edgesFrom(outsider, first)).map((edge) => edge.target_id),
          [second],
        );
        return "the exceptions' edges point from their series, a move lets the old one go, a removal in Marfa is carried, a trash carries the series once, a restore brings its exceptions back, and a calendar of many exceptions finds the same edges through one listing";
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
