import {
  defineConnector,
  main,
  verifyHmac,
  type Entry,
  type Item,
} from "@withmarfa/connector";
import type { Issue } from "./tracker-stub.js";

const env = {
  PROOF_VENDOR_URL: "required",
  PROOF_WEBHOOK_SECRET: "secret",
} as const;

function issueEntry(issue: Issue): Entry {
  return {
    source_id: issue.id,
    properties: {
      issue_id: issue.id,
      title: issue.title,
      body: issue.body,
      closed: issue.state === "closed",
    },
    changed_at: issue.updated_at,
    connections: {
      "proof.sub-issue": issue.sub_issues.map((id) => ({
        type: "proof.issue",
        id,
      })),
    },
  };
}

/** The connector the tracker proof runs: GitHub's shape on a stub,
 *  sub-issues and attachments; a Marfa trash closes it, reopened later. */
const connector = defineConnector({
  name: "proof-tracker",
  description: "Issues and attachments from the proof's stub tracker.",
  source: "proof-tracker",
  types: [
    {
      type: {
        id: "proof.issue",
        label: "Issue",
        description: "An issue from the proof's stub tracker.",
        link_field: "issue_id",
        fields: {
          issue_id: { type: "string" },
          title: { type: "string", required: true },
          body: { type: "string" },
          closed: { type: "boolean" },
        },
      },
      fields: ["issue_id", "title", "body", "closed"],
      readOnly: ["closed"],
      revive: true,
    },
    {
      type: {
        id: "proof.attachment",
        label: "Attachment",
        description: "A file attached to an issue in the proof's stub tracker.",
        parent: "core.file.image",
        link_field: "attachment_id",
        fields: { attachment_id: { type: "string" } },
      },
      fields: ["attachment_id", "title", "blob_ref", "mime_type"],
    },
  ],
  connections: [
    {
      id: "proof.sub-issue",
      label: "Sub-issue",
      description: "An issue beneath another in the proof's stub tracker.",
      cardinality: "one-to-many",
      source_type_constraints: ["proof.issue"],
      target_type_constraints: ["proof.issue"],
    },
    {
      id: "attached-to",
      cardinality: "many-to-many",
      source_type_constraints: ["proof.attachment"],
      target_type_constraints: ["proof.issue"],
    },
  ],
  carries: () => ["proof.issue"],
  env,
  async run({ env: values, signal, hints, upsert }) {
    const call = async (path: string): Promise<Response> =>
      fetch(new URL(path, values.PROOF_VENDOR_URL), { signal });
    const named = hints?.get("proof.issue");
    const issues: Issue[] = [];
    if (named === undefined) {
      issues.push(...((await (await call("issues")).json()) as Issue[]));
    } else {
      for (const id of named) {
        const answer = await call(`issues/${encodeURIComponent(id)}`);
        if (answer.ok) issues.push((await answer.json()) as Issue);
      }
    }
    await upsert("proof.issue", issues.map(issueEntry));
    await upsert(
      "proof.attachment",
      issues.flatMap((issue) =>
        issue.attachments.map(({ id, etag }) => ({
          source_id: id,
          properties: { attachment_id: id, title: `${id}.png` },
          file: {
            key: etag,
            load: async (loading: AbortSignal) => {
              const answer = await fetch(
                new URL(`attachments/${id}`, values.PROOF_VENDOR_URL),
                { signal: loading },
              );
              if (!answer.ok) {
                throw new Error(
                  `the tracker answered ${String(answer.status)}`,
                );
              }
              return {
                bytes: new Uint8Array(await answer.arrayBuffer()),
                mime_type: answer.headers.get("content-type") ?? "image/png",
              };
            },
          },
          connections: {
            "attached-to": [{ type: "proof.issue", id: issue.id }],
          },
        })),
      ),
    );
  },
  async onChange(change, context) {
    const send = async (
      method: string,
      path: string,
      body?: unknown,
    ): Promise<Issue> => {
      const answer = await fetch(new URL(path, context.env.PROOF_VENDOR_URL), {
        method,
        signal: context.signal,
        headers: { "Content-Type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      if (!answer.ok) {
        throw new Error(`the tracker answered ${String(answer.status)}`);
      }
      return (await answer.json()) as Issue;
    };
    const linkOf = (item: Item): string => String(item.properties["issue_id"]);
    const { item } = change;
    let issue: Issue;
    if (change.kind === "created") {
      issue = await send("POST", "issues", {
        title: item.properties["title"],
        body: item.properties["body"] ?? "",
      });
      await context.setLink(item, issue.id);
    } else if (change.kind === "trashed" || change.kind === "purged") {
      // Never linked: the stub keeps no key a lost create could be found by.
      if (item.properties["issue_id"] === undefined) return undefined;
      const closing = encodeURIComponent(linkOf(item));
      return issueEntry(
        await send("PATCH", `issues/${closing}`, { state: "closed" }),
      );
    } else if (change.kind === "archived") {
      return undefined;
    } else {
      const fields = Object.fromEntries(
        [...change.changed].map((field) => [
          field,
          item.properties[field] ?? "",
        ]),
      );
      issue = await send(
        "PATCH",
        `issues/${encodeURIComponent(linkOf(item))}`,
        { ...fields, ...(change.kind === "restored" && { state: "open" }) },
      );
    }
    const id = encodeURIComponent(issue.id);
    const subs = change.connections?.["proof.sub-issue"];
    for (const target of subs?.added ?? []) {
      issue = await send("POST", `issues/${id}/sub_issues`, {
        sub_issue_id: linkOf(target),
      });
    }
    for (const target of subs?.removed ?? []) {
      issue = await send(
        "DELETE",
        `issues/${id}/sub_issues/${encodeURIComponent(linkOf(target))}`,
      );
    }
    return issueEntry(issue);
  },
  inbound: {
    verify: (delivery, values) =>
      verifyHmac({
        secret: values.PROOF_WEBHOOK_SECRET,
        body: delivery.body,
        signature: delivery.header("X-Hub-Signature-256"),
        prefix: "sha256=",
      }),
    hints: (delivery) => {
      const said = JSON.parse(new TextDecoder().decode(delivery.body)) as {
        issue: string;
      };
      return [{ type: "proof.issue", id: said.issue }];
    },
  },
});

await main(connector);
