import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { createClient, type MarfaClient } from "@withmarfa/client";
import { check } from "./check.js";
import {
  ConnectorUnderProof,
  create,
  edit,
  item,
  lastRun,
  moved,
  registration,
  restore,
  rowsOf,
  trash,
  type Item,
} from "./connector.js";
import { appKey, GitHubStub } from "./github-stub.js";

const source = "github";
const entry = resolve(
  import.meta.dirname,
  "../../../connectors/github/dist/main.js",
);
const types = ["github.repository", "github.issue", "github.comment"];
const connections = [
  "github.in-repository",
  "github.sub-issue-of",
  "github.blocked-by",
  "in-thread",
];

async function targets(
  marfa: MarfaClient,
  from: Item,
  edgeType: string,
): Promise<string[]> {
  const { data, error } = await marfa.GET("/items/{id}/edges", {
    params: { path: { id: from.id }, query: { edge_type: edgeType } },
  });
  if (data === undefined)
    throw new Error(`the edges were refused: ${JSON.stringify(error)}`);
  return data.data.map((edge) => edge.target_id);
}

async function connect(
  marfa: MarfaClient,
  from: Item,
  to: Item,
  edgeType: string,
): Promise<void> {
  const { error, response } = await marfa.POST("/edges", {
    body: { source_id: from.id, target_id: to.id, edge_type: edgeType },
  });
  if (!response.ok)
    throw new Error(`the edge was refused: ${JSON.stringify(error)}`);
}

export async function proveGitHub(
  marfa: MarfaClient,
  url: string,
): Promise<void> {
  const github = await new GitHubStub().start();
  try {
    const repository = github.addRepository("someone/tracker");
    const parent = github.addIssue(repository, {
      title: "Parent",
      labels: ["bug"],
    });
    const child = github.addIssue(repository, {
      title: "Child",
      parent: parent.node,
    });
    const blocker = github.addIssue(repository, { title: "Blocker" });
    child.blocked_by = [blocker.node];
    const comment = github.addComment(parent, "First!");
    let key = { id: "", key: "" };
    const env = {
      GITHUB_APP_ID: "12345",
      GITHUB_PRIVATE_KEY: appKey(),
      GITHUB_WEBHOOK_SECRET: "github-proof-webhook-secret",
      GITHUB_API_URL: github.url,
    };
    const runOnce = async (): Promise<string> => {
      const runner = new ConnectorUnderProof(source, url, key.key, env);
      const { code, output } = await runner.once();
      if (code !== 0)
        throw new Error(`the run exited ${String(code)}: ${output}`);
      return output;
    };
    const rows = async (): Promise<Map<string, Item>> => {
      const all = new Map<string, Item>();
      for (const type of types) {
        for (const [id, row] of await rowsOf(marfa, type, source)) {
          all.set(id, row);
        }
      }
      return all;
    };
    const row = async (node: string): Promise<Item> => {
      const found = (await rows()).get(node);
      if (found === undefined) throw new Error(`no row holds ${node}`);
      return found;
    };

    await check(
      "github: its key is minted with write on its three types and four connection types, in-thread among them, and the metadata to register them",
      async () => {
        const { data, error } = await marfa.POST("/keys", {
          body: {
            label: source,
            source,
            type_permissions: Object.fromEntries(
              types.map((type) => [type, "write" as const]),
            ),
            edge_permissions: Object.fromEntries(
              connections.map((type) => [type, "write" as const]),
            ),
            metadata_permissions: { types: "write", edge_types: "write" },
            default_tier: "feed",
          },
        });
        if (data === undefined)
          throw new Error(`the key was refused: ${JSON.stringify(error)}`);
        key = data;
        return `a key for ${source} with ${types.join(", ")} and ${connections.join(", ")}`;
      },
    );

    await check(
      "github: the first run registers its types as kinds of the core's, writes the repository, the issues and the comment, and connects them, the comment in its issue's thread through the instance's in-thread",
      async () => {
        await runOnce();
        const parents = await Promise.all(
          types.map(async (type) => {
            const { data } = await marfa.GET("/types/{id}", {
              params: { path: { id: type } },
            });
            return `${type} on ${data?.parent ?? "nothing"}`;
          }),
        );
        const repo = await row(repository.node);
        const top = await row(parent.node);
        const below = await row(child.node);
        const said = await row(comment.node);
        const [inRepo, subOf, blockedBy, thread] = await Promise.all([
          targets(marfa, top, "github.in-repository"),
          targets(marfa, below, "github.sub-issue-of"),
          targets(marfa, below, "github.blocked-by"),
          targets(marfa, said, "in-thread"),
        ]);
        const blockerRow = await row(blocker.node);
        const kinds = await marfa.GET("/edge-types");
        const registered = (kinds.data?.data ?? [])
          .filter((kind) => connections.includes(kind.id))
          .map((kind) => `${kind.id} ${kind.cascade_on_delete}`);
        if (
          parents.join() !==
            "github.repository on core.entity,github.issue on core.task,github.comment on core.message" ||
          inRepo.join() !== repo.id ||
          subOf.join() !== top.id ||
          blockedBy.join() !== blockerRow.id ||
          thread.join() !== top.id ||
          top.properties["status"] !== "pending" ||
          JSON.stringify(top.properties["labels"]) !== '["bug"]'
        ) {
          throw new Error(
            `${parents.join(", ")}; in repository ${inRepo.join()}, sub-issue of ${subOf.join()}, blocked by ${blockedBy.join()}, in thread ${thread.join()}; ${JSON.stringify(top.properties)}`,
          );
        }
        return `${parents.join(", ")}; ${registered.join(", ")}, and in-thread the instance's own; the child under its parent and blocked by the blocker, the comment in the parent's thread`;
      },
    );

    await check(
      "github: a second run asks GitHub only with ETags it answers 304, and moves no row",
      async () => {
        await runOnce();
        const before = await rows();
        const asked = github.asked.length;
        await runOnce();
        const listings = github.asked
          .slice(asked)
          .filter((one) => one.path.startsWith("/repos/"));
        const changed = moved(before, await rows());
        if (listings.some((one) => one.status !== 304) || changed.length > 0) {
          throw new Error(
            `${listings.map((one) => `${one.path} ${String(one.status)}`).join(", ")}; moved ${changed.join()}`,
          );
        }
        return `${String(listings.length)} listings, each 304; no row moved`;
      },
    );

    await check(
      "github: a blocker swapped on GitHub, which moves no issue's time, is taken on the next run",
      async () => {
        const other = github.addIssue(repository, { title: "Other blocker" });
        child.blocked_by = [other.node];
        await runOnce();
        const now = await targets(
          marfa,
          await row(child.node),
          "github.blocked-by",
        );
        const expected = (await row(other.node)).id;
        if (now.join() !== expected) {
          throw new Error(`blocked by ${now.join()}, not ${expected}`);
        }
        return `the child is blocked by ${other.node} alone`;
      },
    );

    await check(
      "github: an edit in Marfa reaches GitHub under the App, and the run after carries nothing back",
      async () => {
        await edit(marfa, await row(parent.node), {
          title: "Parent, from Marfa",
          labels: ["bug", "p1"],
        });
        await runOnce();
        const written = github.writes().length;
        await runOnce();
        if (
          parent.title !== "Parent, from Marfa" ||
          parent.labels.join() !== "bug,p1" ||
          github.writes().length !== written
        ) {
          throw new Error(
            `GitHub holds ${parent.title} ${parent.labels.join()}; ${String(github.writes().length - written)} writes after`,
          );
        }
        return "GitHub holds the new title and labels; nothing sent on the run after";
      },
    );

    await check(
      "github: an issue and a comment made in Marfa become GitHub's, each linked, the issue given its number and placed under its parent",
      async () => {
        const made = await create(marfa, "github.issue", {
          title: "Made in Marfa",
          body: "From the proof",
        });
        await connect(
          marfa,
          made,
          await row(repository.node),
          "github.in-repository",
        );
        await connect(
          marfa,
          made,
          await row(parent.node),
          "github.sub-issue-of",
        );
        const said = await create(marfa, "github.comment", {
          body: "Said in Marfa",
          from: "the proof",
        });
        await connect(marfa, said, await row(parent.node), "in-thread");
        await runOnce();
        const issue = github.issues.find(
          (one) => one.title === "Made in Marfa",
        );
        const comment = github.comments.find((one) =>
          one.body.startsWith("Said in Marfa"),
        );
        const madeRow = await item(marfa, made.id);
        const saidRow = await item(marfa, said.id);
        if (
          issue === undefined ||
          comment === undefined ||
          issue.parent !== parent.node ||
          comment.issue !== parent.node ||
          madeRow.properties["github_id"] !== issue.node ||
          madeRow.properties["number"] !== issue.number ||
          saidRow.properties["github_id"] !== comment.node ||
          // Marked on GitHub, and read back without the mark.
          !/^From the proof\n\n<!-- marfa:[0-9a-f]{16} -->$/.test(
            issue.body ?? "",
          ) ||
          madeRow.properties["body"] !== "From the proof" ||
          saidRow.properties["body"] !== "Said in Marfa"
        ) {
          throw new Error(
            `issue ${JSON.stringify(issue)}, comment ${JSON.stringify(comment)}, rows ${JSON.stringify([madeRow.properties, saidRow.properties])}`,
          );
        }
        return `${issue.node} as #${String(issue.number)} under ${parent.node}, and ${comment.node} in its thread`;
      },
    );

    await check(
      "github: a trash in Marfa closes the issue as not planned, a comment on GitHub brings it back as GitHub has it, a trash of it closed changes nothing on GitHub, and a restore reopens what a trash closed",
      async () => {
        await trash(marfa, (await row(child.node)).id);
        await runOnce();
        const closed = `${child.state} ${String(child.state_reason)}`;
        const binned = (await row(child.node)).state;
        github.addComment(child, "Still wanted");
        await runOnce();
        const back = await row(child.node);
        await trash(marfa, back.id);
        const writes = github.writes().length;
        await runOnce();
        const untouched = github.writes().length === writes;
        await restore(marfa, back.id);
        await runOnce();
        await edit(marfa, await row(child.node), { status: "pending" });
        await runOnce();
        await trash(marfa, back.id);
        await runOnce();
        await restore(marfa, back.id);
        await runOnce();
        const reopened = `${child.state} ${String(child.state_reason)}`;
        const after = await row(child.node);
        if (
          closed !== "closed not_planned" ||
          binned !== "trashed" ||
          back.state !== "active" ||
          back.properties["status"] !== "canceled" ||
          !untouched ||
          reopened !== "open reopened" ||
          after.properties["status"] !== "pending"
        ) {
          throw new Error(
            `closed ${closed}, then ${binned}, back ${back.state} ${String(back.properties["status"])}, ${untouched ? "untouched" : "written"} by the second trash, reopened ${reopened}, row ${String(after.properties["status"])}`,
          );
        }
        return "closed as not planned; back, canceled, on GitHub's comment; a trash of it closed wrote nothing; reopened on the restore after it was reopened and trashed, the row pending";
      },
    );

    await check(
      "github: an issue GitHub says was deleted is archived, found through what the instance holds under the repository",
      async () => {
        blocker.deleted = true;
        await runOnce();
        const gone = await row(blocker.node);
        if (gone.state !== "archived") {
          throw new Error(`the deleted issue's row is ${gone.state}`);
        }
        return `${blocker.node} archived on GitHub's 410`;
      },
    );

    await check(
      "github: a repository taken out of the installation has its rows archived, and an installation that refuses the App changes nothing",
      async () => {
        repository.installation = 2;
        const output = await runOnce();
        const taken = await rows();
        const active = [...taken.values()].filter(
          (one) => one.state === "active",
        );
        if (active.length > 0 || !output.includes("taken out")) {
          throw new Error(
            `${String(active.length)} rows still active: ${output}`,
          );
        }
        repository.installation = 1;
        await runOnce();
        const back = [...(await rows()).values()].filter(
          (one) => one.state === "active",
        ).length;
        const installation = github.installations[0];
        if (installation !== undefined) installation.lost = true;
        const lost = await runOnce();
        const still = [...(await rows()).values()].filter(
          (one) => one.state === "active",
        ).length;
        const summary = String((await lastRun(marfa, key.id)).summary);
        if (back === 0 || still !== back || !lost.includes("refused it")) {
          throw new Error(
            `${String(back)} back, ${String(still)} after the loss: ${summary}`,
          );
        }
        return `every row archived and ${String(back)} back once it was added again; the installation's refusal left ${String(still)} active and said so`;
      },
    );

    let path = "";
    const post = async (
      event: string,
      said: Record<string, unknown>,
      signedWith = env.GITHUB_WEBHOOK_SECRET,
    ): Promise<number> => {
      const body = JSON.stringify(said);
      const answer = await fetch(`${url}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": event,
          "X-GitHub-Delivery": crypto.randomUUID(),
          "X-Hub-Signature-256": `sha256=${createHmac("sha256", signedWith).update(body).digest("hex")}`,
        },
        body,
      });
      return answer.status;
    };

    await check(
      "github: a delivery signed with the App's webhook secret is processed at the endpoint made for it, and one signed otherwise rejected",
      async () => {
        const installation = github.installations[0];
        if (installation !== undefined) installation.lost = false;
        const connectorId = (await registration(marfa, key.id)).id;
        const own = createClient({ baseUrl: url, credential: key.key });
        const { data, error } = await own.POST("/connectors/{id}/endpoints", {
          params: { path: { id: connectorId } },
          body: { label: "github", duplicate_header: "X-GitHub-Delivery" },
        });
        if (data === undefined)
          throw new Error(`the endpoint was refused: ${JSON.stringify(error)}`);
        path = data.path;
        const statuses = [
          await post("ping", { zen: "Design for failure." }),
          await post("ping", { zen: "Forged" }, "a guess"),
        ];
        await runOnce();
        const summary = String((await lastRun(marfa, key.id)).summary);
        if (
          statuses.join() !== "202,202" ||
          !summary.includes("deliveries processed 1, rejected 1")
        ) {
          throw new Error(
            `answered ${statuses.join()}; the run said ${summary}`,
          );
        }
        return `both answered 202; the run said ${summary.slice(summary.indexOf("deliveries"))}`;
      },
    );

    await check(
      "github: running on a schedule, the connector takes an issue edited on GitHub within seconds of its delivery, asking GitHub's GraphQL for that issue alone and listing no repository's issues or comments",
      async () => {
        const child = spawn(
          "node",
          [entry, "--every", "1h", "--look-every", "1s"],
          {
            env: {
              PATH: process.env["PATH"],
              MARFA_URL: url,
              MARFA_KEY: key.key,
              ...env,
            },
            stdio: "ignore",
          },
        );
        const exited = new Promise<void>((done) =>
          child.once("exit", () => {
            done();
          }),
        );
        const until = async (holds: () => Promise<boolean>, what: string) => {
          const deadline = Date.now() + 30_000;
          while (!(await holds())) {
            if (Date.now() > deadline)
              throw new Error(`${what} never happened`);
            await new Promise((done) => setTimeout(done, 200));
          }
        };
        try {
          const before = (await lastRun(marfa, key.id)).reported_at;
          await until(
            async () => (await lastRun(marfa, key.id)).reported_at !== before,
            "the scheduled run",
          );
          const settled = (await lastRun(marfa, key.id)).reported_at;
          await post("ping", {});
          await until(
            async () => (await lastRun(marfa, key.id)).reported_at !== settled,
            "the first run for deliveries",
          );
          github.asked.length = 0;
          github.edit(parent, { title: "Parent, renamed on GitHub" });
          const sentAt = Date.now();
          await post("issues", {
            action: "edited",
            issue: { node_id: parent.node },
          });
          await until(
            async () =>
              (await row(parent.node)).properties["title"] ===
              "Parent, renamed on GitHub",
            "the edit being written",
          );
          const took = Date.now() - sentAt;
          const listed = github.asked.filter((one) =>
            one.path.startsWith("/repos/"),
          );
          const asked = github.asked.flatMap((one) =>
            one.path === "/graphql"
              ? ((one.body as { variables?: { ids?: string[] } }).variables
                  ?.ids ?? [])
              : [],
          );
          if (listed.length > 0 || [...new Set(asked)].join() !== parent.node) {
            throw new Error(
              `GitHub was asked for ${listed.map((one) => one.path).join()} and ${asked.join()}`,
            );
          }
          return `written ${String(took)} ms after its delivery, GitHub asked ${github.asked.map((one) => `${one.method} ${one.path}`).join(", ")}`;
        } finally {
          child.kill("SIGTERM");
          await exited;
        }
      },
    );
  } finally {
    await github.stop();
  }
}
