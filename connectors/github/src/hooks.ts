import type { Delivery, Hint } from "@withmarfa/connector";
import { commentType, issueType } from "./entries.js";

type Payload = Record<string, unknown>;

function nodeOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const node = (value as Payload)["node_id"];
  return typeof node === "string" && node !== "" ? node : undefined;
}

function named(type: string, ...values: unknown[]): Hint[] {
  return values.flatMap((value) => {
    const id = nodeOf(value);
    return id === undefined ? [] : [{ type, id }];
  });
}

export function hints(delivery: Delivery): readonly Hint[] | "everything" {
  const event = delivery.header("x-github-event");
  if (
    event === "installation" ||
    event === "installation_repositories" ||
    event === "repository"
  ) {
    return "everything";
  }
  const payload = JSON.parse(
    new TextDecoder().decode(delivery.body),
  ) as Payload;
  switch (event) {
    case "issues": {
      const changes = payload["changes"] as Payload | undefined;
      return named(issueType, payload["issue"], changes?.["new_issue"]);
    }
    case "issue_comment": {
      const issue = payload["issue"] as Payload | undefined;
      if (issue?.["pull_request"] !== undefined) return [];
      return [
        ...named(commentType, payload["comment"]),
        ...named(issueType, issue),
      ];
    }
    case "sub_issues":
      return named(issueType, payload["sub_issue"], payload["parent_issue"]);
    case "issue_dependencies":
      return named(
        issueType,
        payload["blocked_issue"],
        payload["blocking_issue"],
      );
    default:
      return [];
  }
}
