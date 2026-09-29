import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { createClient, type MarfaClient } from "@withmarfa/client";
import { check } from "./check.js";
import {
  ConnectorUnderProof,
  create,
  edit,
  lastRun,
  moved,
  purge,
  registration,
  restore,
  rowsOf,
  trash,
  type Item,
} from "./connector.js";
import { pixel, Tracker } from "./tracker-stub.js";

const entry = resolve(import.meta.dirname, "tracker-connector.js");
const secret = "proof-tracker-webhook-secret";
const source = "proof-tracker";

interface Minted {
  id: string;
  key: string;
}

/** The key the README's command mints for a connector with connections. */
async function mintWithConnections(
  marfa: MarfaClient,
  label: string,
  keySource: string,
  edges: boolean,
): Promise<Minted> {
  const { data, error } = await marfa.POST("/keys", {
    body: {
      label,
      source: keySource,
      type_permissions: {
        "proof.issue": "write",
        "proof.attachment": "write",
      },
      ...(edges && {
        edge_permissions: {
          "proof.sub-issue": "write",
          "attached-to": "write",
        },
      }),
      metadata_permissions: { types: "write", edge_types: "write" },
      default_tier: "feed",
    },
  });
  if (data === undefined)
    throw new Error(`the key was refused: ${JSON.stringify(error)}`);
  return data;
}

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

async function until(
  holds: () => Promise<boolean>,
  what: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error(`${what} never happened`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

export async function proveTracker(
  marfa: MarfaClient,
  url: string,
): Promise<void> {
  const tracker = await new Tracker().start();
  try {
    const parent = tracker.add("Parent");
    const child = tracker.add("Child");
    const loose = tracker.add("Loose");
    parent.sub_issues.push(child.id);
    const attachment = tracker.attach(parent, pixel, "image/png");
    const env = {
      PROOF_VENDOR_URL: tracker.url,
      PROOF_WEBHOOK_SECRET: secret,
    };
    let key: Minted = { id: "", key: "" };
    let runner = new ConnectorUnderProof(source, url, "", env, entry);
    const runOnce = async (): Promise<string> => {
      const { code, output } = await runner.once();
      if (code !== 0)
        throw new Error(`the run exited ${String(code)}: ${output}`);
      return output;
    };
    const issues = () => rowsOf(marfa, "proof.issue", source);
    const row = async (id: string): Promise<Item> => {
      const found = (await issues()).get(id);
      if (found === undefined) throw new Error(`no row holds ${id}`);
      return found;
    };
    const writesSince = (count: number): string[] =>
      tracker.writes().slice(count);

    await check(
      "tracker: its key is minted with write on its types and connection types, and the metadata to register both",
      async () => {
        key = await mintWithConnections(marfa, source, source, true);
        runner = new ConnectorUnderProof(source, url, key.key, env, entry);
        return `a key for ${source} with proof.issue, proof.attachment, proof.sub-issue and attached-to`;
      },
    );

    await check(
      "tracker: the first run writes the issues, the sub-issue connection and the attachment, uploading its bytes once and attaching it, and registers the connection type to orphan",
      async () => {
        await runOnce();
        const rows = await issues();
        const files = await rowsOf(marfa, "proof.attachment", source);
        const file = files.get(attachment.id);
        const top = await row(parent.id);
        const subs = await targets(marfa, top, "proof.sub-issue");
        const attached =
          file === undefined ? [] : await targets(marfa, file, "attached-to");
        const kinds = await marfa.GET("/edge-types");
        const kind = kinds.data?.data.find(
          (type) => type.id === "proof.sub-issue",
        );
        const loads = tracker.asked.filter((asked) =>
          asked.path.startsWith("/attachments/"),
        ).length;
        if (
          rows.size !== 3 ||
          subs.join() !== (await row(child.id)).id ||
          attached.join() !== top.id ||
          !String(file?.properties["blob_ref"]).startsWith("sha256:") ||
          file?.properties["mime_type"] !== "image/png" ||
          kind?.cascade_on_delete !== "orphan" ||
          loads !== 1
        ) {
          throw new Error(
            `${String(rows.size)} issues, sub-issues ${subs.join()}, attached ${attached.join()}, file ${JSON.stringify(file?.properties)}, edge type ${JSON.stringify(kind)}, ${String(loads)} loads`,
          );
        }
        return `3 issues, ${parent.id} → ${child.id} as proof.sub-issue, the attachment at ${String(file.properties["blob_ref"]).slice(0, 15)}… attached to ${parent.id}, loaded once, proof.sub-issue orphaning on delete`;
      },
    );

    await check(
      "tracker: a second run loads no bytes, writes no row and carries nothing",
      async () => {
        const before = await issues();
        const asked = tracker.asked.length;
        const written = tracker.writes().length;
        await runOnce();
        const loads = tracker.asked
          .slice(asked)
          .filter((one) => one.path.startsWith("/attachments/")).length;
        const changed = moved(before, await issues());
        if (
          loads !== 0 ||
          changed.length > 0 ||
          writesSince(written).length > 0
        ) {
          throw new Error(
            `${String(loads)} loads, rows moved ${changed.join()}, the tracker took ${writesSince(written).join()}`,
          );
        }
        return "no load, no row moved, nothing sent to the tracker";
      },
    );

    await check(
      "tracker: a run finds, through the server's edge filter, the row holding a connection to another",
      async () => {
        const output = await runOnce();
        const said = `the parents of ${child.id} are ${parent.id}`;
        if (
          !output.includes(said) ||
          output.includes(`parents of ${parent.id}`)
        ) {
          throw new Error(`the run said: ${output}`);
        }
        return said;
      },
    );

    await check(
      "tracker: the pinned server reads the attachment's dimensions, its type inheriting from core.file.image",
      async () => {
        await until(async () => {
          const file = (await rowsOf(marfa, "proof.attachment", source)).get(
            attachment.id,
          );
          return (
            file?.properties["width"] === 1 && file.properties["height"] === 1
          );
        }, "width and height on the attachment");
        return "width 1 and height 1 on the connector's own attachment type";
      },
    );

    await check(
      "tracker: an edit and a sub-issue made in Marfa reach the tracker, and the kit's own writes are not carried back",
      async () => {
        const top = await row(parent.id);
        await edit(marfa, top, { title: "Parent, edited in Marfa" });
        await connect(marfa, top, await row(loose.id), "proof.sub-issue");
        const written = tracker.writes().length;
        await runOnce();
        const sent = writesSince(written);
        const again = tracker.writes().length;
        await runOnce();
        if (
          parent.title !== "Parent, edited in Marfa" ||
          !parent.sub_issues.includes(loose.id) ||
          writesSince(again).length > 0
        ) {
          throw new Error(
            `the tracker took ${sent.join()}, then ${writesSince(again).join()}; parent ${JSON.stringify(parent)}`,
          );
        }
        return `the tracker took ${sent.join(", ")}, and nothing on the run after`;
      },
    );

    await check(
      "tracker: a trash in Marfa closes the issue, and the close does not bring the row back",
      async () => {
        await trash(marfa, (await row(child.id)).id);
        await runOnce();
        const written = tracker.writes().length;
        await runOnce();
        const state = (await row(child.id)).state;
        if (
          child.state !== "closed" ||
          state !== "trashed" ||
          writesSince(written).length > 0
        ) {
          throw new Error(
            `the tracker holds ${child.state}, the row is ${state}, then the tracker took ${writesSince(written).join()}`,
          );
        }
        return `the tracker closed ${child.id}, the row stayed in the bin, and nothing was sent after`;
      },
    );

    await check(
      "tracker: the tracker's own later activity brings the trashed issue back, and the return is not carried",
      async () => {
        child.state = "open";
        child.title = "Child, reopened";
        child.updated_at = tracker.touch();
        await runOnce();
        const back = await row(child.id);
        const summary = (await lastRun(marfa, key.id)).summary ?? "";
        const written = tracker.writes().length;
        await runOnce();
        if (
          back.state !== "active" ||
          back.properties["title"] !== "Child, reopened" ||
          !summary.includes(
            "while it was in the bin, so it was brought back",
          ) ||
          writesSince(written).length > 0
        ) {
          throw new Error(
            `the row is ${back.state} with ${String(back.properties["title"])}; the report said ${summary}; the tracker took ${writesSince(written).join()}`,
          );
        }
        return "active again with the tracker's title, the run naming it brought back, and nothing sent after";
      },
    );

    await check(
      "tracker: a trash and a restore made by a person's own row cascading reach the tracker as nothing",
      async () => {
        const note = await create(marfa, "core.note", { body: "holds Loose" });
        const target = await row(loose.id);
        await connect(marfa, note, target, "parent-of");
        await trash(marfa, note.id);
        const taken = await row(loose.id);
        const written = tracker.writes().length;
        await runOnce();
        const afterTrash = writesSince(written);
        await restore(marfa, note.id);
        await runOnce();
        const restored = await row(loose.id);
        if (
          taken.state !== "trashed" ||
          taken.trashed_by_cascade !== true ||
          afterTrash.length > 0 ||
          writesSince(written).length > 0 ||
          loose.state !== "open" ||
          restored.state !== "active"
        ) {
          throw new Error(
            `the cascade left the row ${taken.state}, marked ${String(taken.trashed_by_cascade)}; the tracker took ${writesSince(written).join()}; it holds ${loose.state}; the row is ${restored.state}`,
          );
        }
        return `${loose.id} went into the bin with the note and came back with it, and the tracker took nothing`;
      },
    );

    await check(
      "tracker: a purge in Marfa closes the issue once, unlinks nothing at the tracker, and holds after the state is cleared and the key replaced",
      async () => {
        const gone = await row(loose.id);
        await trash(marfa, gone.id);
        await runOnce();
        await purge(marfa, gone.id);
        const written = tracker.writes().length;
        await runOnce();
        const onPurge = writesSince(written);
        const connectorId = (await registration(marfa, key.id)).id;
        const cleared = await createClient({
          baseUrl: url,
          credential: key.key,
        }).DELETE("/connectors/{id}/state", {
          params: { path: { id: connectorId } },
        });
        if (!cleared.response.ok) {
          throw new Error(
            `the clear was refused: ${JSON.stringify(cleared.error)}`,
          );
        }
        const revoked = await marfa.DELETE("/keys/{id}", {
          params: { path: { id: key.id } },
        });
        if (!revoked.response.ok) throw new Error("the revoke was refused");
        key = await mintWithConnections(marfa, `${source}-2`, source, true);
        runner = new ConnectorUnderProof(source, url, key.key, env, entry);
        await runOnce();
        const held = (await issues()).has(loose.id);
        if (
          onPurge.join() !== `PATCH /issues/${loose.id}` ||
          !parent.sub_issues.includes(loose.id) ||
          held
        ) {
          throw new Error(
            `on the purge the tracker took ${onPurge.join()}; ${parent.id}'s sub-issues ${parent.sub_issues.join()}; the row came back: ${String(held)}`,
          );
        }
        loose.title = "Loose, changed at the tracker";
        loose.updated_at = tracker.touch();
        await runOnce();
        const reborn = await row(loose.id);
        if (reborn.id === gone.id) throw new Error("the purged id came back");
        return `the tracker took ${onPurge.join()} alone and keeps ${loose.id} as a sub-issue; a cleared state and a new key wrote nothing back until the tracker changed it, then a new row`;
      },
    );

    await check(
      "tracker: a sub-issue removed in Marfa is removed at the tracker, and one the tracker removed is removed in Marfa",
      async () => {
        const top = await row(parent.id);
        const edges = await marfa.GET("/items/{id}/edges", {
          params: {
            path: { id: top.id },
            query: { edge_type: "proof.sub-issue" },
          },
        });
        const reborn = await row(loose.id);
        const edge = edges.data?.data.find(
          (candidate) => candidate.target_id === reborn.id,
        );
        if (edge === undefined) {
          throw new Error(`${parent.id} holds no edge to ${loose.id}`);
        }
        const removed = await marfa.DELETE("/edges/{id}", {
          params: { path: { id: edge.id } },
        });
        if (!removed.response.ok) throw new Error("the removal was refused");
        const written = tracker.writes().length;
        await runOnce();
        const sent = writesSince(written);
        parent.sub_issues = parent.sub_issues.filter((id) => id !== child.id);
        parent.updated_at = tracker.touch();
        await runOnce();
        const left = await targets(marfa, top, "proof.sub-issue");
        if (
          sent.join() !==
            `DELETE /issues/${parent.id}/sub_issues/${loose.id}` ||
          parent.sub_issues.includes(loose.id) ||
          left.length > 0
        ) {
          throw new Error(
            `the tracker took ${sent.join()} and holds ${parent.sub_issues.join()}; Marfa keeps ${left.join()}`,
          );
        }
        return `the tracker took ${sent.join()}, and Marfa let go of ${child.id} once the tracker did`;
      },
    );

    await check(
      "tracker: a sub-issue whose issue the tracker does not show yet is connected once it does",
      async () => {
        const late = tracker.add("Late");
        tracker.hidden.add(late.id);
        parent.sub_issues.push(late.id);
        parent.updated_at = tracker.touch();
        await runOnce();
        const top = await row(parent.id);
        const before = await targets(marfa, top, "proof.sub-issue");
        tracker.hidden.delete(late.id);
        await runOnce();
        const after = await targets(marfa, top, "proof.sub-issue");
        const made = await row(late.id);
        if (before.length > 0 || after.join() !== made.id) {
          throw new Error(
            `before ${before.join()}, after ${after.join()}, the row ${made.id}`,
          );
        }
        return `no connection while ${late.id} was hidden, and ${parent.id} → ${late.id} once it was read`;
      },
    );

    await check(
      "tracker: a key that may not write its connection types is refused at start",
      async () => {
        const narrow = await mintWithConnections(
          marfa,
          `${source}-narrow`,
          `${source}-narrow`,
          false,
        );
        const refused = await new ConnectorUnderProof(
          source,
          url,
          narrow.key,
          env,
          entry,
        ).once();
        const error = (await lastRun(marfa, narrow.id)).error ?? "";
        if (refused.code !== 1 || !error.includes("may not write edge")) {
          throw new Error(`exit ${String(refused.code)}, ${error}`);
        }
        return error.slice(error.indexOf("may not write"));
      },
    );

    await check(
      "tracker: a second process under the key does not run while the first holds the connector",
      async () => {
        tracker.slowList = 3000;
        const listed = tracker.asked.length;
        const first = runner.once();
        await until(
          () =>
            Promise.resolve(
              tracker.asked
                .slice(listed)
                .some((asked) => asked.path === "/issues"),
            ),
          "the first run reading the tracker",
        );
        const second = await runner.once();
        tracker.slowList = 0;
        const done = await first;
        if (
          second.code !== 0 ||
          !second.output.includes("another process holds this connector") ||
          done.code !== 0
        ) {
          throw new Error(
            `the second exited ${String(second.code)}: ${second.output}; the first ${String(done.code)}`,
          );
        }
        return "the second exited 0 saying another process holds the connector, and the first finished";
      },
    );

    await check(
      "tracker: under a schedule, a delivery fetches only the issue it names, and an edit in Marfa reaches the tracker within a look",
      async () => {
        const own = createClient({ baseUrl: url, credential: key.key });
        const connectorId = (await registration(marfa, key.id)).id;
        const made = await own.POST("/connectors/{id}/endpoints", {
          params: { path: { id: connectorId } },
          body: { duplicate_header: "X-GitHub-Delivery" },
        });
        if (made.data === undefined) throw new Error("no endpoint was made");
        const path = made.data.path;
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
        try {
          const before = (await lastRun(marfa, key.id)).reported_at;
          await until(
            async () => (await lastRun(marfa, key.id)).reported_at !== before,
            "the scheduled run",
          );
          parent.title = "Parent, changed at the tracker";
          parent.updated_at = tracker.touch();
          const asked = tracker.asked.length;
          const body = JSON.stringify({ issue: parent.id });
          await fetch(`${url}${path}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-GitHub-Delivery": "55555555-5555-5555-5555-555555555555",
              "X-Hub-Signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
            },
            body,
          });
          await until(
            async () =>
              (await row(parent.id)).properties["title"] ===
              "Parent, changed at the tracker",
            "the delivered change being written",
          );
          const fetched = tracker.asked
            .slice(asked)
            .filter((one) => one.method === "GET")
            .map((one) => one.path);
          const written = tracker.writes().length;
          await edit(marfa, await row(parent.id), {
            body: "written in Marfa",
          });
          await until(
            () => Promise.resolve(parent.body === "written in Marfa"),
            "the edit reaching the tracker",
          );
          if (fetched.some((one) => one === "/issues")) {
            throw new Error(`the delivery's run fetched ${fetched.join()}`);
          }
          return `the delivery's run fetched ${[...new Set(fetched)].join(", ")}; the edit reached the tracker as ${writesSince(written).join(", ")}`;
        } finally {
          child.kill("SIGTERM");
          await exited;
        }
      },
    );
  } finally {
    await tracker.stop();
  }
}
