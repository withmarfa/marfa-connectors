import type { Delivery, Hint } from "@withmarfa/connector";
import { commentType, issueType, pullRequestType } from "./entries.js";

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

function pullRequestsFromCheck(
  value: unknown,
  repository: unknown,
): readonly Hint[] {
  if (typeof value !== "object" || value === null) return [];
  const prs = (value as Payload)["pull_requests"];
  if (!Array.isArray(prs)) return [];
  const repo = nodeOf(repository);
  return prs.flatMap((pr: unknown) => {
    const node = nodeOf(pr);
    if (node !== undefined) return [{ type: pullRequestType, id: node }];
    const number =
      typeof pr === "object" && pr !== null
        ? (pr as Payload)["number"]
        : undefined;
    return repo !== undefined &&
      typeof number === "number" &&
      Number.isSafeInteger(number) &&
      number > 0
      ? [{ type: pullRequestType, id: `number:${repo}:${String(number)}` }]
      : [];
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
    case "issue_relates_to":
      return named(issueType, payload["issue"], payload["related_issue"]);
    case "issue_dependencies":
      return named(
        issueType,
        payload["blocked_issue"],
        payload["blocking_issue"],
      );
    case "pull_request":
      return named(pullRequestType, payload["pull_request"]);
    case "check_run":
      return pullRequestsFromCheck(payload["check_run"], payload["repository"]);
    case "check_suite":
      return pullRequestsFromCheck(
        payload["check_suite"],
        payload["repository"],
      );
    case "status": {
      const repo = nodeOf(payload["repository"]);
      const sha = payload["sha"];
      return repo !== undefined &&
        typeof sha === "string" &&
        /^[a-f0-9]{6,64}$/i.test(sha)
        ? [{ type: pullRequestType, id: `commit:${repo}:${sha}` }]
        : [];
    }
    default:
      return [];
  }
}
