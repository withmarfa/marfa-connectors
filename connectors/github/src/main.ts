import {
  defineConnector,
  main,
  verifyHmac,
  type TypeDefinition,
} from "@withmarfa/connector";
import {
  blockedBy,
  relatesTo,
  duplicateOf,
  commentType,
  githubClosedBy,
  githubCloses,
  inRepository,
  inThread,
  issueType,
  pullRequestType,
  repositoryType,
  subIssueOf,
} from "./entries.js";
import { defaultBase, type App } from "./github.js";
import { hints } from "./hooks.js";
import { read } from "./read.js";
import { fileKinds, filesConnection } from "./files.js";
import { scopeOf } from "./scope.js";
import { readOnly, setUp } from "./setup.js";
import { carry, remake } from "./write.js";
import comment from "./github.comment.json" with { type: "json" };
import issue from "./github.issue.json" with { type: "json" };
import pullRequest from "./github.pull_request.json" with { type: "json" };
import repository from "./github.repository.json" with { type: "json" };

const env = {
  GITHUB_APP_ID: "optional",
  GITHUB_PRIVATE_KEY: "optional-secret",
  GITHUB_WEBHOOK_SECRET: "optional-secret",
  GITHUB_PERSONAL_TOKEN: "optional-secret",
  GITHUB_READ_ONLY: "optional",
  GITHUB_API_URL: "optional",
  GITHUB_PUBLIC_URL: "optional",
  GITHUB_ORGANIZATION: "optional",
  GITHUB_APP_NAME: "optional",
  GITHUB_REPOSITORIES: "optional",
} as const;

function appOf(values: {
  GITHUB_APP_ID: string | undefined;
  GITHUB_PRIVATE_KEY: string | undefined;
  GITHUB_API_URL: string | undefined;
}): App {
  if (
    values.GITHUB_APP_ID === undefined ||
    values.GITHUB_PRIVATE_KEY === undefined
  )
    throw new Error(
      "GitHub writes require GITHUB_APP_ID and GITHUB_PRIVATE_KEY",
    );
  return {
    appId: values.GITHUB_APP_ID,
    privateKey: values.GITHUB_PRIVATE_KEY,
    base: values.GITHUB_API_URL ?? defaultBase,
  };
}

const connector = defineConnector<typeof env>({
  name: "github",
  description:
    "Repositories, issues, comments and read-only pull requests through a personal access token or GitHub App, with relations, closing links and checks. Personal token runs are read only; App runs can carry issue and comment edits back.",
  source: "github",
  types: [
    ...fileKinds,
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
        "private",
        "author",
        "labels",
        "assignees",
        "state_reason",
        "github_updated_at",
        "github_files",
        "parent_url",
        "blocked_by_urls",
        "related_urls",
        "duplicate_of_url",
        "closed_by_url",
      ],
      readOnly: [
        "completed_at",
        "url",
        "number",
        "repository",
        "private",
        "author",
        "state_reason",
        "github_updated_at",
        "github_files",
        "parent_url",
        "blocked_by_urls",
        "related_urls",
        "duplicate_of_url",
        inRepository,
        duplicateOf,
        "closed_by_url",
        githubClosedBy,
      ],
      derived: ["private", "github_files"],
      revive: true,
    },
    {
      type: comment as TypeDefinition,
      fields: [
        "github_id",
        "body",
        "from",
        "repository",
        "private",
        "url",
        "github_files",
      ],
      readOnly: [
        "github_files",
        "from",
        "repository",
        "private",
        "url",
        inThread,
        inRepository,
      ],
      derived: ["private", "github_files"],
    },
    {
      type: pullRequest as TypeDefinition,
      fields: [
        "github_id",
        "title",
        "body",
        "status",
        "completed_at",
        "url",
        "number",
        "repository",
        "private",
        "author",
        "pr_state",
        "draft",
        "merged_at",
        "base_branch",
        "head_branch",
        "checks",
        "github_updated_at",
      ],
      readOnly: [
        "title",
        "body",
        "status",
        "completed_at",
        "url",
        "number",
        "repository",
        "private",
        "author",
        "pr_state",
        "draft",
        "merged_at",
        "base_branch",
        "head_branch",
        "checks",
        "github_updated_at",
        inRepository,
        githubCloses,
      ],
      derived: ["private"],
    },
  ],
  connections: [
    filesConnection,
    {
      id: inRepository,
      label: "In repository",
      description:
        "An issue, comment or pull request in the GitHub repository it belongs to.",
      cardinality: "many-to-one",
      source_type_constraints: [issueType, commentType, pullRequestType],
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
      id: relatesTo,
      label: "Relates to",
      description: "Two related GitHub issues, ordered by node ID.",
      cardinality: "many-to-many",
      source_type_constraints: [issueType],
      target_type_constraints: [issueType],
    },
    {
      id: duplicateOf,
      label: "Duplicate of",
      description: "A duplicate GitHub issue and its canonical issue.",
      cardinality: "many-to-one",
      source_type_constraints: [issueType],
      target_type_constraints: [issueType],
    },
    {
      id: inThread,
      cardinality: "many-to-one",
      source_type_constraints: [commentType],
      target_type_constraints: [issueType],
    },
    {
      id: githubCloses,
      label: "Closes",
      description:
        "A GitHub pull request and an issue it closes, from the pull request's closing issues references.",
      cardinality: "many-to-many",
      source_type_constraints: [pullRequestType],
      target_type_constraints: [issueType],
    },
    {
      id: githubClosedBy,
      label: "Closed by",
      description: "A GitHub issue and the synced pull request that closed it.",
      cardinality: "many-to-one",
      source_type_constraints: [issueType],
      target_type_constraints: [pullRequestType],
    },
  ],
  env,
  carries: (values) =>
    values.GITHUB_PERSONAL_TOKEN !== undefined
      ? []
      : [issueType, commentType].filter(
          (kind) =>
            !readOnly(values.GITHUB_READ_ONLY, kind.slice("github.".length)),
        ),
  checkEnv(values) {
    scopeOf(values.GITHUB_REPOSITORIES);
    readOnly(values.GITHUB_READ_ONLY);
    const app = [
      values.GITHUB_APP_ID,
      values.GITHUB_PRIVATE_KEY,
      values.GITHUB_WEBHOOK_SECRET,
    ];
    if (values.GITHUB_PERSONAL_TOKEN !== undefined) {
      if (app.some((one) => one !== undefined))
        throw new Error(
          "choose either GITHUB_PERSONAL_TOKEN or the GitHub App settings",
        );
    } else if (app.some((one) => one === undefined)) {
      throw new Error(
        "set GITHUB_PERSONAL_TOKEN or all of GITHUB_APP_ID, GITHUB_PRIVATE_KEY and GITHUB_WEBHOOK_SECRET",
      );
    }
  },
  setup(context) {
    return setUp(context, context.env);
  },
  run(context) {
    return read(
      context,
      context.env.GITHUB_PERSONAL_TOKEN === undefined
        ? appOf(context.env)
        : {
            token: context.env.GITHUB_PERSONAL_TOKEN,
            base: context.env.GITHUB_API_URL ?? defaultBase,
          },
      scopeOf(context.env.GITHUB_REPOSITORIES),
    );
  },
  onChange(change, context) {
    return carry(change, context, appOf(context.env));
  },
  remake(change, context) {
    return remake(change, context, appOf(context.env));
  },
  ...(process.env["GITHUB_PERSONAL_TOKEN"]?.trim()
    ? {}
    : {
        inbound: {
          verify: (delivery, values) =>
            verifyHmac({
              secret: values.GITHUB_WEBHOOK_SECRET ?? "",
              body: delivery.body,
              signature: delivery.header("x-hub-signature-256"),
              prefix: "sha256=",
            }),
          hints,
        },
      }),
});

await main(connector);
