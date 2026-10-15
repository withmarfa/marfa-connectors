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

/** PR node ids from a check_run or check_suite payload's pull_requests
 *  array, which GitHub populates for PRs open at the time of the check. */
function pullRequestsFromCheck(payload: Payload): readonly Hint[] {
  const prs = payload["pull_requests"];
  if (!Array.isArray(prs)) return [];
  return prs.flatMap((pr) => named(pullRequestType, pr));
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
    case "check_suite":
      // check_run and check_suite payloads carry a pull_requests array with
      // the PRs open against the checked ref at the time of the event.
      return pullRequestsFromCheck(payload);
    case "status":
      // status payloads carry a sha but no PR node ids; a scheduled run
      // picks up any check-state change on open PRs.
      return [];
    default:
      return [];
  }
}
