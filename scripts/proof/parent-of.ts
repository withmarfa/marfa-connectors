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
        return "the exceptions' edges point from their series, a move lets the old one go, a removal in Marfa is carried, a trash carries the series once and a restore brings its exceptions back";
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
