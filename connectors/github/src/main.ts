import {
  defineConnector,
  main,
  verifyHmac,
  type TypeDefinition,
} from "@withmarfa/connector";
import {
  blockedBy,
  commentType,
  inRepository,
  inThread,
  issueType,
  repositoryType,
  subIssueOf,
} from "./entries.js";
import { defaultBase, type App } from "./github.js";
import { hints } from "./hooks.js";
import { read } from "./read.js";
import { scopeOf } from "./scope.js";
import { readOnly, setUp } from "./setup.js";
import { carry, remake } from "./write.js";
import comment from "./github.comment.json" with { type: "json" };
import issue from "./github.issue.json" with { type: "json" };
import repository from "./github.repository.json" with { type: "json" };

const env = {
  GITHUB_APP_ID: "required",
  GITHUB_PRIVATE_KEY: "secret",
  GITHUB_WEBHOOK_SECRET: "secret",
  GITHUB_READ_ONLY: "optional",
  GITHUB_API_URL: "optional",
  GITHUB_PUBLIC_URL: "optional",
  GITHUB_ORGANIZATION: "optional",
  GITHUB_APP_NAME: "optional",
  GITHUB_REPOSITORIES: "optional",
} as const;

function appOf(values: {
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_API_URL: string | undefined;
}): App {
  return {
    appId: values.GITHUB_APP_ID,
    privateKey: values.GITHUB_PRIVATE_KEY,
    base: values.GITHUB_API_URL ?? defaultBase,
  };
}

const connector = defineConnector({
  name: "github",
  description:
    "Repositories, issues and their comments from the repositories a GitHub App is installed on, with sub-issues and blockers, and changes made in Marfa carried back.",
  source: "github",
  types: [
    {
      // Imported JSON widens every string; the check on start holds the
      // file to the server's.
      type: repository as TypeDefinition,
      fields: [
        "github_id",
        "name",
        "url",
        "description",
        "private",
        "archived_on_github",
      ],
    },
    {
      type: issue as TypeDefinition,
      fields: [
        "github_id",
        "title",
        "body",
        "status",
        "completed_at",
        "url",
        "number",
        "repository",
        "author",
        "labels",
        "assignees",
        "state_reason",
        "github_updated_at",
        "parent_url",
        "blocked_by_urls",
      ],
      readOnly: [
        "completed_at",
        "url",
        "number",
        "repository",
        "author",
        "state_reason",
        "github_updated_at",
        "parent_url",
        "blocked_by_urls",
        inRepository,
      ],
      revive: true,
    },
    {
      type: comment as TypeDefinition,
      fields: ["github_id", "body", "from", "repository", "url"],
      readOnly: ["from", "repository", "url", inThread, inRepository],
    },
  ],
  connections: [
    {
      id: inRepository,
      label: "In repository",
      description:
        "An issue or comment in the GitHub repository it belongs to.",
      cardinality: "many-to-one",
      source_type_constraints: [issueType, commentType],
      target_type_constraints: [repositoryType],
    },
    {
      id: subIssueOf,
      label: "Sub-issue of",
      description: "A GitHub issue beneath its parent issue.",
      cardinality: "many-to-one",
      source_type_constraints: [issueType],
      target_type_constraints: [issueType],
    },
    {
      id: blockedBy,
      label: "Blocked by",
      description: "A GitHub issue blocked by another.",
      cardinality: "many-to-many",
      source_type_constraints: [issueType],
      target_type_constraints: [issueType],
    },
    {
      id: inThread,
      cardinality: "many-to-one",
      source_type_constraints: [commentType],
      target_type_constraints: [issueType],
    },
  ],
  env,
  carries: (values) =>
    readOnly(values.GITHUB_READ_ONLY) ? [] : [issueType, commentType],
  checkEnv(values) {
    scopeOf(values.GITHUB_REPOSITORIES);
  },
  setup(context) {
    return setUp(context, context.env);
  },
  run(context) {
    return read(
      context,
      appOf(context.env),
      scopeOf(context.env.GITHUB_REPOSITORIES),
    );
  },
  onChange(change, context) {
    return carry(change, context, appOf(context.env));
  },
  remake(change, context) {
    return remake(change, context, appOf(context.env));
  },
  inbound: {
    verify: (delivery, values) =>
      verifyHmac({
        secret: values.GITHUB_WEBHOOK_SECRET,
        body: delivery.body,
        signature: delivery.header("x-hub-signature-256"),
        prefix: "sha256=",
      }),
    hints,
  },
});

await main(connector);
