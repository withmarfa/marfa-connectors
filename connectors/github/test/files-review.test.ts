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
import { read } from "../src/read.js";
import { GitHubStub } from "../../../scripts/proof/github-stub.js";
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
const pullRequest = { ...parent, id: "github.pull_request" };
const discussion = { ...parent, id: "github.discussion" };
const repositoryType = {
  id: "github.repository",
  label: "Repository",
  link_field: "github_id",
  fields: { github_id: { type: "string" } },
} as TypeDefinition;
const repositoryFileType: TypeDefinition = {
  id: "github.repository_file",
  label: "Repository file",
  fields: { path: { type: "string" } },
};
const directoryType: TypeDefinition = {
  ...repositoryFileType,
  id: "github.directory",
  label: "Directory",
};
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
async function fixture(content = png, mime = "image/png") {
  const active = new Harness(
    await new ScriptedServer("github", {
      types: [parent.id, comment.id, pullRequest.id, discussion.id],
    }).start(),
  );
  h = active;
  active.server.grants = {
    type_permissions: Object.fromEntries(
      [
        parent.id,
        comment.id,
        pullRequest.id,
        discussion.id,
        "github.repository",
        "github.file",
        "github.file.image",
        repositoryFileType.id,
        directoryType.id,
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
  let retainDeliveryCondition = false;
  let rendered: string | undefined;
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
          bodyHTML:
            rendered ??
            `<img src="https://private-user-images.githubusercontent.com/42/123-${assetId}.png?jwt=signature-${String(revision)}"><a href="https://github.com/user-attachments/files/1/note.txt">Note</a>`,
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
      ...[repositoryFileType, directoryType].map((type) => ({
        type,
        fields: ["path"],
      })),
      ...[parent, comment, pullRequest, discussion].map((type) => ({
        type,
        fields: ["github_id", "body", "repository", "private", "github_files"],
        derived: ["github_files", "private"],
        readOnly: ["github_files", "private"],
      })),
    ],
    connections: [
      filesConnection,
      {
        id: "github.in-repository",
        cardinality: "many-to-one",
        source_type_constraints: [
          parent.id,
          comment.id,
          pullRequest.id,
          discussion.id,
          repositoryFileType.id,
          directoryType.id,
        ],
        target_type_constraints: [repositoryType.id],
      },
    ],
    async run(root) {
      const context = root.forScope("repository");
      const reached = new Set<string>();
      await context.upsert(repositoryType.id, [
        { source_id: "repoNode", properties: { github_id: "repoNode" } },
      ]);
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
                    { type: repositoryType.id, id: "repoNode" },
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
            id: "repoNode",
            name: repository,
            private: parents.some(
              (p) => p.repository === repository && p.private,
            ),
          },
          {
            fetch: fetcher,
            reached: (id) => {
              reached.add(`github-files:${id}`);
            },
            checkpoint: async (parent) =>
              acknowledge &&
              (await context.state.checkpoint("github-files-last", parent))
                .committed,
          },
        );
      root.log.unreached({
        keys: retainDeliveryCondition ? ["github-files:one"] : [],
        prefixes: ["github-files:"],
        exceptKeys: [...reached],
      });
    },
  });
  return {
    h: active,
    once: () => start(connector, active.runtime(["--once"])),
    deliveryRetention: (value: boolean) => {
      retainDeliveryCondition = value;
    },
    html: (value: string) => {
      rendered = value;
    },
    readEmpty: async (denied = false) => {
      const github = await new GitHubStub().start();
      github.personalToken = "review-token";
      if (denied) {
        github.addRepository("owner/repo", {
          private: false,
          node: "repoNode",
        });
        github.listingsFailing = 10;
      }
      try {
        return await start(
          defineConnector({
            ...connector,
            run: (context) =>
              read(
                context,
                { token: "review-token", base: github.url },
                undefined,
                { token: undefined, scopeText: undefined },
                [],
              ),
          }),
          active.runtime(["--once"]),
        );
      } finally {
        await github.stop();
      }
    },
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
    mark: async (
      hidden: boolean,
      repository = "owner/repo",
      repositoryId = "repoNode",
    ) => {
      const privacy = defineConnector({
        ...connector,
        run: (context) =>
          markFilesPrivate(
            context,
            new Map([[repositoryId, { name: repository, private: hidden }]]),
          ),
      });
      return start(privacy, active.runtime(["--once"]));
    },
  };
}
it("follows privacy after repository rename", async () => {
  const f = await fixture();
  expect(await f.once()).toBe(0);
  expect(f.h.server.row(id).properties["private"]).toBe(false);
  f.parents([
    { id: "one", type: parent.id, private: true, repository: "owner/renamed" },
  ]);
  expect(await f.once()).toBe(0);
  expect(await f.mark(true, "owner/renamed")).toBe(0);
  expect(f.h.server.row(id).properties["private"]).toBe(true);
});
it("restores current privacy after file restore", async () => {
  const f = await fixture();
  expect(await f.once()).toBe(0);
  const file = f.h.server.row(id);
  f.h.server.trash(file.id);
  f.parents([
    { id: "one", type: parent.id, private: true, repository: "owner/repo" },
  ]);
  expect(await f.mark(true)).toBe(0);
  f.h.server.restore(file.id);
  expect(await f.once()).toBe(0);
  expect(f.h.server.row(id).properties["private"]).toBe(true);
});
it("follows same-name visibility without trash", async () => {
  const f = await fixture();
  expect(await f.once()).toBe(0);
  f.parents([
    { id: "one", type: parent.id, private: true, repository: "owner/repo" },
  ]);
  expect(await f.once()).toBe(0);
  expect(await f.mark(true)).toBe(0);
  expect(f.h.server.row(id).properties["private"]).toBe(true);
});
it("mixed signed and unavailable UUIDs remain pending", async () => {
  const f = await fixture();
  const other = "11234567-89ab-4cde-8123-456789abcdef";
  f.text(
    body + `\n![Other](https://github.com/user-attachments/assets/${other})`,
  );
  f.html(
    `<img src="https://private-user-images.githubusercontent.com/42/123-${id}.png?jwt=first"><a href="https://github.com/user-attachments/assets/${other}">Other</a>`,
  );
  expect(await f.once()).toBe(0);
  const note = f.h.server.row("one").properties["github_files"] as {
    pending: boolean;
    not_kept: Record<string, string>;
  };
  expect(note.pending).toBe(true);
  expect(Object.keys(note.not_kept)).toContain(
    `https://github.com/user-attachments/assets/${other}`,
  );
});
it("retains pending failure on unrelated empty read", async () => {
  const f = await fixture();
  f.setStatus(403);
  expect(await f.once()).toBe(0);
  expect(f.h.server.problems.get("github")).toHaveProperty("github-files:one");
  expect(await f.readEmpty(), f.h.lines.join("\n")).toBe(0);
  expect(
    (f.h.server.row("one").properties["github_files"] as { pending: boolean })
      .pending,
  ).toBe(true);
  expect(f.h.server.problems.get("github")).toHaveProperty("github-files:one");
});
it("access removal retains conservative file privacy", async () => {
  const f = await fixture();
  expect(await f.once()).toBe(0);
  const saved = f.h.server.states.get("github");
  if (saved === undefined) throw new Error("No GitHub state");
  (saved["state"] as Record<string, unknown>)["repositories"] = {
    repoNode: { installation: 0, name: "owner/repo", private: false },
  };
  expect(await f.readEmpty(), f.h.lines.join("\n")).toBe(0);
  expect(f.h.server.row("one").state).toBe("archived");
  expect(f.h.server.row(id).state).toBe("active");
  expect(f.h.server.row(id).properties["private"]).toBe(true);
});
it("wholly unavailable signed UUID is pending", async () => {
  const f = await fixture();
  f.html(
    `<a href="https://github.com/user-attachments/assets/${id}">Image</a>`,
  );
  expect(await f.once()).toBe(0);
  expect(
    (f.h.server.row("one").properties["github_files"] as { pending: boolean })
      .pending,
  ).toBe(true);
});

it("follows repository identity when a renamed parent's body cannot be read", async () => {
  const f = await fixture();
  expect(await f.once()).toBe(0);
  expect(await f.mark(true, "owner/renamed")).toBe(0);
  expect(f.h.server.row("one").properties["repository"]).toBe("owner/repo");
  expect(f.h.server.row(id).properties["private"]).toBe(true);
  expect(f.counts().loads).toBe(1);
});
it("refreshes archived file metadata without restoring its lifecycle", async () => {
  const f = await fixture();
  expect(await f.once()).toBe(0);
  f.h.server.transition(f.h.server.row(id).id, "archived");
  expect(await f.mark(true)).toBe(0);
  expect(f.h.server.row(id).properties["private"]).toBe(true);
  expect(f.h.server.row(id).state).toBe("archived");
});
it("ignores attachment examples in rendered code blocks", async () => {
  const f = await fixture();
  f.text("```html\n" + body + "\n```");
  f.html(
    `<pre><code><img src="https://private-user-images.githubusercontent.com/42/123-${id}.png?jwt=example"><a href="https://github.com/user-attachments/assets/${id}">Example</a></code></pre>`,
  );
  expect(await f.once()).toBe(0);
  expect(f.counts().loads).toBe(0);
  expect(
    (f.h.server.row("one").properties["github_files"] as { pending: boolean })
      .pending,
  ).toBe(false);
  const before = f.counts();
  expect(await f.once()).toBe(0);
  expect(f.counts()).toEqual(before);
});
it("clears a retained attachment condition only after its own successful retry", async () => {
  const f = await fixture();
  f.setStatus(403);
  expect(await f.once()).toBe(0);
  expect(await f.readEmpty()).toBe(0);
  expect(f.h.server.problems.get("github")).toHaveProperty("github-files:one");
  f.setStatus(200);
  expect(await f.once()).toBe(0);
  expect(f.h.server.problems.get("github")).not.toHaveProperty(
    "github-files:one",
  );
});

it("does not use a reused repository name as visibility evidence", async () => {
  const f = await fixture();
  f.parents([
    { id: "one", type: parent.id, private: true, repository: "owner/repo" },
  ]);
  expect(await f.once()).toBe(0);
  expect(await f.mark(false, "owner/repo", "different-repository-node")).toBe(
    0,
  );
  expect(f.h.server.row(id).properties["private"]).toBe(true);
});
it("reconciles a restored file after access removal erased repository progress", async () => {
  const f = await fixture();
  expect(await f.once()).toBe(0);
  const file = f.h.server.row(id);
  f.h.server.trash(file.id);
  const saved = f.h.server.states.get("github");
  if (!saved) throw new Error("No GitHub state");
  (saved["state"] as Record<string, unknown>)["repositories"] = {
    repoNode: { installation: 0, name: "owner/repo", private: false },
  };
  expect(await f.readEmpty()).toBe(0);
  expect(file.state).toBe("trashed");
  f.h.server.restore(file.id);
  expect(await f.readEmpty()).toBe(0);
  expect(f.h.server.row(id).state).toBe("active");
  expect(f.h.server.row(id).properties["private"]).toBe(true);
});
it("retries unfinished attachment work after a repository rename", async () => {
  const f = await fixture();
  f.setStatus(403);
  expect(await f.once()).toBe(0);
  f.parents([
    { id: "one", type: parent.id, private: true, repository: "owner/renamed" },
  ]);
  f.setStatus(200);
  expect(await f.once()).toBe(0);
  expect(f.h.server.row(id).properties["private"]).toBe(true);
  expect(
    (f.h.server.row("one").properties["github_files"] as { pending: boolean })
      .pending,
  ).toBe(false);
  expect(f.counts().loads).toBe(2);
});

it("marks retained files private when listed repository denies its read", async () => {
  const f = await fixture();
  expect(await f.once(), f.h.lines.join("\n")).toBe(0);
  const saved = f.h.server.states.get("github");
  if (!saved) throw new Error("No GitHub state");
  (saved["state"] as Record<string, unknown>)["repositories"] = {
    repoNode: { installation: 0, name: "owner/repo", private: false },
  };
  expect(await f.readEmpty(true), f.h.lines.join("\n")).toBe(0);
  expect(f.h.server.row("one").properties["private"]).toBe(true);
  expect(f.h.server.row(id).properties["private"]).toBe(true);
});
it("clears completed note condition on scheduled reread", async () => {
  const f = await fixture();
  f.setStatus(403);
  expect(await f.once()).toBe(0);
  expect(f.h.server.problems.get("github")).toHaveProperty("github-files:one");
  f.text("");
  f.html("");
  f.deliveryRetention(true);
  expect(await f.once()).toBe(0);
  expect(
    (f.h.server.row("one").properties["github_files"] as { pending: boolean })
      .pending,
  ).toBe(false);
  expect(f.h.server.problems.get("github")).toHaveProperty("github-files:one");
  f.deliveryRetention(false);
  expect(await f.once()).toBe(0);
  expect(f.h.server.problems.get("github")).not.toHaveProperty(
    "github-files:one",
  );
});

it("records unsigned upload text after an HTML image without fetching the file", async () => {
  const f = await fixture();
  const unsigned = "https://github.com/user-attachments/files/1/note.txt";
  f.text(
    `<img src="https://github.com/user-attachments/assets/${id}">\n[Note](${unsigned})`,
  );
  f.html(
    `<a href="https://private-user-images.githubusercontent.com/42/123-${id}.png?jwt=fresh"><img src="https://private-user-images.githubusercontent.com/42/123-${id}.png?jwt=fresh"></a>\n[Note](${unsigned})`,
  );
  expect(await f.once()).toBe(0);
  const note = f.h.server.row("one").properties["github_files"] as {
    not_kept: Record<string, string>;
    pending: boolean;
  };
  expect(note.not_kept[unsigned]).toBe(
    "GitHub did not sign this upload for API download",
  );
  expect(note.pending).toBe(false);
  expect(f.counts().loads).toBe(1);
  const counts = f.counts();
  expect(await f.once()).toBe(0);
  expect(f.counts()).toEqual(counts);
});
