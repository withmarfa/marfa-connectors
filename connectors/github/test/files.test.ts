import { afterEach, expect, it } from "vitest";
import {
  defineConnector,
  type TypeDefinition,
} from "../../../kit/src/define.js";
import { start } from "../../../kit/src/main.js";
import { Harness } from "../../../kit/test/harness.js";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import {
  fileKinds,
  filesConnection,
  preserveFiles,
  markFilesPrivate,
  fileNotes,
} from "../src/files.js";
import type { Client } from "../src/github.js";
const id = "01234567-89ab-4cde-8123-456789abcdef";
const body = `![Image](https://github.com/user-attachments/assets/${id})`;
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const parent: TypeDefinition = {
  id: "github.issue",
  label: "Issue",
  link_field: "github_id",
  fields: {
    github_id: { type: "string" },
    body: { type: "string" },
    repository: { type: "string" },
    private: { type: "boolean" },
    github_files: { type: "object" },
  },
};
const comment = { ...parent, id: "github.comment" };
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
async function fixture() {
  const active = new Harness(
    await new ScriptedServer("github", {
      types: [parent.id, comment.id],
    }).start(),
  );
  h = active;
  active.server.grants = {
    type_permissions: Object.fromEntries(
      [parent.id, comment.id, "github.file", "github.file.image"].map((id) => [
        id,
        "write",
      ]),
    ),
    edge_permissions: { "attached-to": "write" },
    metadata_permissions: { types: "write" },
  };
  let response = 200,
    queryCount = 0,
    loads = 0,
    revision = 1;
  let parents = [
    { id: "one", type: parent.id, private: false, repository: "owner/repo" },
  ];
  const client = {
    graphql: (_text: string, variables: { ids: string[] }) => {
      queryCount++;
      return Promise.resolve({
        nodes: variables.ids.map((node) => ({
          id: node,
          bodyHTML: `<img src="https://private-user-images.githubusercontent.com/42/123-${id}.png?jwt=signature-${String(revision)}"><a href="https://github.com/user-attachments/files/1/note.txt">Note</a>`,
        })),
      });
    },
  } as unknown as Client;
  const fetcher = (() => {
    loads++;
    return Promise.resolve(
      new Response(response === 200 ? png : null, {
        status: response,
        headers: { "content-type": "image/png" },
      }),
    );
  }) as typeof fetch;
  const connector = defineConnector({
    name: "github",
    source: "github",
    env: {},
    types: [
      ...fileKinds,
      ...[parent, comment].map((type) => ({
        type,
        fields: ["github_id", "body", "repository", "private", "github_files"],
        derived: ["github_files"],
        readOnly: ["github_files"],
      })),
    ],
    connections: [filesConnection],
    async run(root) {
      const context = root.forScope("repository");
      for (const type of [parent.id, comment.id])
        await context.upsert(
          type,
          await fileNotes(
            context,
            type,
            parents
              .filter((p) => p.type === type)
              .map((p) => ({
                source_id: p.id,
                properties: {
                  github_id: p.id,
                  body,
                  repository: p.repository,
                  private: p.private,
                },
              })),
          ),
        );
      for (const repository of new Set(parents.map((p) => p.repository)))
        await preserveFiles(context, client, repository, {
          fetch: fetcher,
          checkpoint: async (parent) =>
            (await context.state.checkpoint("github-files-last", parent))
              .committed,
        });
    },
  });
  return {
    h: active,
    once: () => start(connector, active.runtime(["--once"])),
    setStatus: (s: number) => {
      response = s;
    },
    rotate: () => {
      revision++;
    },
    counts: () => ({ queryCount, loads, uploads: active.server.uploads }),
    parents: (p: typeof parents) => {
      parents = p;
    },
    mark: async (hidden: boolean) => {
      const privacy = defineConnector({
        ...connector,
        run: (context) => markFilesPrivate(context, "owner/repo", hidden),
      });
      return start(privacy, active.runtime(["--once"]));
    },
  };
}
it("keeps bytes, accounts for unsigned links, preserves text, and does no work on an unchanged run", async () => {
  const f = await fixture();
  expect(await f.once(), f.h.lines.join("\n")).toBe(0);
  const file = f.h.server.rows.find((r) => r.type === "github.file.image");
  expect(file?.properties["github_id"]).toBe(id);
  expect(file?.properties["mime_type"]).toBe("image/png");
  expect(
    f.h.server.blobs.get(String(file?.properties["blob_ref"]))?.bytes,
  ).toEqual(Buffer.from(png));
  const issue = f.h.server.row("one");
  expect(issue.properties["body"]).toBe(body);
  expect(JSON.stringify(issue.properties["github_files"])).toContain(
    "not sign",
  );
  expect(
    f.h.server.targetsOf(
      (
        file ??
        (() => {
          throw new Error("No image file");
        })()
      ).id,
      "attached-to",
    ),
  ).toEqual([issue.id]);
  const before = f.h.server.rows.map((r) => ({ id: r.id, version: r.version }));
  const counts = f.counts();
  f.rotate();
  expect(await f.once()).toBe(0);
  expect(
    f.counts(),
    JSON.stringify(f.h.server.row("one").properties["github_files"]) +
      "\n" +
      f.h.lines.join("\n"),
  ).toEqual(counts);
  expect(
    f.h.server.rows.map((r) => ({ id: r.id, version: r.version })),
  ).toEqual(before);
});
it("retries a failed download from fresh HTML even with unchanged parent text", async () => {
  const f = await fixture();
  f.setStatus(403);
  await f.once();
  expect(
    f.h.server.rows.filter((r) => r.type.startsWith("github.file")),
  ).toEqual([]);
  f.rotate();
  f.setStatus(200);
  expect(await f.once(), f.h.lines.join("\n")).toBe(0);
  expect(f.counts().loads).toBe(2);
  expect(f.counts().queryCount).toBe(2);
  expect(f.h.server.rows.some((r) => r.type === "github.file.image")).toBe(
    true,
  );
});
it("keeps one UUID attached to multiple parents and retains the strongest visibility", async () => {
  const f = await fixture();
  f.parents([
    { id: "one", type: parent.id, private: false, repository: "owner/repo" },
    { id: "two", type: comment.id, private: true, repository: "owner/secret" },
  ]);
  expect(await f.once(), f.h.lines.join("\n")).toBe(0);
  const file =
    f.h.server.rows.find((r) => r.type === "github.file.image") ??
    (() => {
      throw new Error("No image file");
    })();
  expect(f.h.server.targetsOf(file.id, "attached-to")).toHaveLength(2);
  expect(file.properties["private"]).toBe(true);
  expect(f.counts().loads).toBe(1);
  expect(await f.mark(false)).toBe(0);
  expect(f.h.server.byId(file.id).properties["private"]).toBe(true);
});
it("does not recreate a purged or trashed file", async () => {
  const f = await fixture();
  await f.once();
  const file = f.h.server.row(id);
  f.h.server.purge(id);
  f.parents([
    { id: "one", type: parent.id, private: false, repository: "owner/repo" },
    { id: "two", type: comment.id, private: false, repository: "owner/repo" },
  ]);
  expect(await f.once()).toBe(0);
  expect(
    f.h.server.rows.some(
      (r) => r.id === file.id || r.type.startsWith("github.file"),
    ),
  ).toBe(false);
  expect(f.counts().loads).toBe(1);
});
