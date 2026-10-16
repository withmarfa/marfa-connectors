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
const repositoryType: TypeDefinition = {
  id: "github.repository",
  label: "Repository",
  link_field: "github_id",
  fields: { github_id: { type: "string" } },
};
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
async function fixture(content = png, mime = "image/png") {
  const active = new Harness(
    await new ScriptedServer("github", {
      types: [parent.id, comment.id],
    }).start(),
  );
  h = active;
  active.server.grants = {
    type_permissions: Object.fromEntries(
      [
        parent.id,
        comment.id,
        "github.repository",
        "github.file",
        "github.file.image",
      ].map((id) => [id, "write"]),
    ),
    edge_permissions: {
      "attached-to": "write",
      "github.in-repository": "write",
    },
    metadata_permissions: { types: "write", edge_types: "write" },
  };
  let response = 200,
    queryCount = 0,
    loads = 0,
    revision = 1;
  let text = body;
  let assetId = id;
  let acknowledge = true;
  let parents = [
    { id: "one", type: parent.id, private: false, repository: "owner/repo" },
  ];
  const client = {
    graphql: (_text: string, variables: { ids: string[] }) => {
      queryCount++;
      return Promise.resolve({
        nodes: variables.ids.map((node) => ({
          id: node,
          bodyHTML: `<img src="https://private-user-images.githubusercontent.com/42/123-${assetId}.png?jwt=signature-${String(revision)}"><a href="https://github.com/user-attachments/files/1/note.txt">Note</a>`,
        })),
      });
    },
  } as unknown as Client;
  const fetcher = (() => {
    loads++;
    return Promise.resolve(
      new Response(response === 200 ? content : null, {
        status: response,
        headers: { "content-type": mime },
      }),
    );
  }) as typeof fetch;
  const connector = defineConnector({
    name: "github",
    source: "github",
    env: {},
    types: [
      ...fileKinds,
      { type: repositoryType, fields: ["github_id"] },
      ...[parent, comment].map((type) => ({
        type,
        fields: ["github_id", "body", "repository", "private", "github_files"],
        derived: ["github_files"],
        readOnly: ["github_files"],
      })),
    ],
    connections: [
      filesConnection,
      {
        id: "github.in-repository",
        cardinality: "many-to-one",
        source_type_constraints: [parent.id, comment.id],
        target_type_constraints: [repositoryType.id],
      },
    ],
    async run(root) {
      const context = root.forScope("repository");
      await context.upsert(
        repositoryType.id,
        [...new Set(parents.map((p) => p.repository))].map((repository) => ({
          source_id: `repo:${repository}`,
          properties: { github_id: `repo:${repository}` },
        })),
      );
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
                connections: {
                  "github.in-repository": [
                    { type: repositoryType.id, id: `repo:${p.repository}` },
                  ],
                },
                properties: {
                  github_id: p.id,
                  body: text,
                  repository: p.repository,
                  private: p.private,
                },
              })),
          ),
        );
      for (const repository of new Set(parents.map((p) => p.repository)))
        await preserveFiles(
          context,
          client,
          {
            id: `repo:${repository}`,
            name: repository,
            private: parents.some(
              (p) => p.repository === repository && p.private,
            ),
          },
          {
            fetch: fetcher,
            checkpoint: async (parent) =>
              acknowledge &&
              (await context.state.checkpoint("github-files-last", parent))
                .committed,
          },
        );
    },
  });
  return {
    h: active,
    once: () => start(connector, active.runtime(["--once"])),
    text: (value: string, uuid = id) => {
      text = value;
      assetId = uuid;
    },
    acknowledge: (value: boolean) => {
      acknowledge = value;
    },
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
        run: (context) =>
          markFilesPrivate(
            context,
            new Map([
              ["repo:owner/repo", { name: "owner/repo", private: hidden }],
            ]),
          ),
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
it.each(["purged", "trashed"])(
  "does not recreate a %s file",
  async (operation) => {
    const f = await fixture();
    await f.once();
    const file = f.h.server.row(id);
    if (operation === "purged") f.h.server.purge(id);
    else f.h.server.trash(file.id);
    f.parents([
      { id: "one", type: parent.id, private: false, repository: "owner/repo" },
      { id: "two", type: comment.id, private: false, repository: "owner/repo" },
    ]);
    expect(await f.once()).toBe(0);
    expect(
      f.h.server.rows.some(
        (r) => r.type.startsWith("github.file") && r.state !== "trashed",
      ),
    ).toBe(false);
    expect(f.counts().loads).toBe(1);
  },
);

it("keeps a signed non-image as a generic file", async () => {
  const f = await fixture(
    new TextEncoder().encode("Retained text"),
    "text/plain",
  );
  expect(await f.once(), f.h.lines.join("\n")).toBe(0);
  expect(f.h.server.row(id).type).toBe("github.file");
  expect(f.h.server.row(id).properties["mime_type"]).toBe("text/plain");
});
it("preserves the last good asset while a new asset waits, then retries", async () => {
  const f = await fixture();
  await f.once();
  const kept = f.h.server.row(id).properties["blob_ref"];
  const next = "11234567-89ab-4cde-8123-456789abcdef";
  f.text(body.replace(id, next), next);
  f.setStatus(403);
  await f.once();
  expect(f.h.server.row(id).properties["blob_ref"]).toBe(kept);
  expect(f.counts().uploads).toBe(1);
  f.setStatus(200);
  expect(await f.once()).toBe(0);
  expect(f.h.server.row(next).properties["blob_ref"]).toBe(kept);
  expect(f.counts().loads).toBe(3);
});
it("does not download an existing UUID when its parent text changes", async () => {
  const f = await fixture();
  await f.once();
  f.text(body + "\nAn edit");
  expect(await f.once()).toBe(0);
  expect(f.counts().loads).toBe(1);
  expect(f.counts().uploads).toBe(1);
  const before = f.h.server.rows.map((r) => r.version);
  expect(await f.once()).toBe(0);
  expect(f.h.server.rows.map((r) => r.version)).toEqual(before);
});
it("does not mark attachment work complete without acknowledgement", async () => {
  const f = await fixture();
  f.acknowledge(false);
  await f.once();
  expect(
    (f.h.server.row("one").properties["github_files"] as { pending: boolean })
      .pending,
  ).toBe(true);
  f.acknowledge(true);
  expect(await f.once()).toBe(0);
  expect(
    (f.h.server.row("one").properties["github_files"] as { pending: boolean })
      .pending,
  ).toBe(false);
  expect(f.counts().loads).toBe(1);
});
it("retries after a blob upload loses its response", async () => {
  const f = await fixture();
  f.h.server.resetUploads = true;
  await f.once();
  expect(
    (f.h.server.row("one").properties["github_files"] as { pending: boolean })
      .pending,
  ).toBe(true);
  f.h.server.resetUploads = false;
  expect(await f.once()).toBe(0);
  expect(f.counts().uploads).toBe(2);
  expect(f.h.server.blobs.size).toBe(1);
});
it("refreshes retained file visibility without downloading again", async () => {
  const f = await fixture();
  await f.once();
  expect(await f.mark(true)).toBe(0);
  expect(f.h.server.row(id).properties["private"]).toBe(true);
  expect(await f.mark(false)).toBe(0);
  expect(f.h.server.row(id).properties["private"]).toBe(false);
  expect(f.counts().loads).toBe(1);
});
