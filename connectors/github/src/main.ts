import {
  defineConnector,
  main,
  verifyHmac,
  type TypeDefinition,
} from "@withmarfa/connector";
import {
  blockedBy,
  childOf,
  relatesTo,
  duplicateOf,
  commentType,
  discussionType,
  githubClosedBy,
  githubCloses,
  inRepository,
  inThread,
  issueType,
  pullRequestType,
  references,
  repositoryType,
  subIssueOf,
} from "./entries.js";
import { carryDiscussions, remakeDiscussions } from "./discussion-write.js";
import { defaultBase, spacingOf, type App } from "./github.js";
import { hints } from "./hooks.js";
import { notificationType } from "./notifications.js";
import { read } from "./read.js";
import { fileKinds, filesConnection } from "./files.js";
import {
  directoryType,
  filesOf,
  inCollection,
  repositoryFileType,
} from "./repository-files.js";
import { scopeOf } from "./scope.js";
import { readOnly, setUp, starsOn } from "./setup.js";
import { carry, remake } from "./write.js";
import comment from "./github.comment.json" with { type: "json" };
import discussion from "./github.discussion.json" with { type: "json" };
import issue from "./github.issue.json" with { type: "json" };
import pullRequest from "./github.pull_request.json" with { type: "json" };
import notification from "./github.notification.json" with { type: "json" };
import repository from "./github.repository.json" with { type: "json" };
import repositoryFile from "./github.repository_file.json" with { type: "json" };
import directory from "./github.directory.json" with { type: "json" };

const env = {
  GITHUB_APP_ID: "optional",
  GITHUB_PRIVATE_KEY: "optional-secret",
  GITHUB_WEBHOOK_SECRET: "optional-secret",
  GITHUB_PERSONAL_TOKEN: "optional-secret",
  GITHUB_NOTIFICATIONS_TOKEN: "optional-secret",
  GITHUB_READ_ONLY: "optional",
  GITHUB_STARS: "optional",
  GITHUB_API_URL: "optional",
  GITHUB_REQUEST_SPACING_MS: "optional",
  GITHUB_PUBLIC_URL: "optional",
  GITHUB_ORGANIZATION: "optional",
  GITHUB_APP_NAME: "optional",
  GITHUB_REPOSITORIES: "optional",
  GITHUB_FILES: "optional",
} as const;

function appOf(values: {
  GITHUB_APP_ID: string | undefined;
  GITHUB_PRIVATE_KEY: string | undefined;
  GITHUB_API_URL: string | undefined;
  GITHUB_REQUEST_SPACING_MS: string | undefined;
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
    spacingMs: spacingOf(values),
  };
}

// A process that reads no stars holds no star field, so it never writes or
// puts back the marks another process sets on the rows it syncs. A value
// checkEnv refuses holds them here; the start stops before any row is read.
const starFields =
  process.env["GITHUB_STARS"] === "false" ? [] : ["starred", "starred_at"];

const connector = defineConnector<typeof env>({
  name: "github",
  description:
    "Repositories, issues, discussions, comments, read-only pull requests, read-only notifications and read-only Markdown files from chosen repository paths through a personal access token or GitHub App, with relations, closing links and checks. Personal token runs are read only; App runs can carry issue, discussion and comment edits back.",
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
        ...starFields,
        "synced",
      ],
      readOnly: [...starFields, "synced"],
      derived: [...starFields, "synced"],
      // Nothing turns a synced row into a star-only one: a star-only write,
      // or one process putting back what it last wrote, leaves `synced`
      // alone, and a row another process has marked synced since this one
      // agreed on it is not this one's to archive.
      policy: (item, entry, archiving) =>
        item?.properties["synced"] !== true
          ? {}
          : archiving !== undefined && !archiving.agrees("synced")
            ? { owned: false }
            : entry?.properties["synced"] !== true
              ? { fields: { synced: "observe" } }
              : {},
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
        childOf,
        inRepository,
      ],
      derived: ["private", "github_files"],
    },
    {
      type: discussion as TypeDefinition,
      fields: [
        "github_id",
        "title",
        "body",
        "number",
        "repository",
        "private",
        "author",
        "category",
        "status",
        "state_reason",
        "answered",
        "locked",
        "url",
        "github_updated_at",
      ],
      readOnly: [
        "number",
        "repository",
        "private",
        "author",
        "category",
        "answered",
        "locked",
        "url",
        "github_updated_at",
        inRepository,
      ],
      derived: ["private"],
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
    {
      type: notification as TypeDefinition,
      fields: [
        "body",
        "from",
        "github_id",
        "reason",
        "unread",
        "github_updated_at",
        "last_read_at",
        "subject_type",
        "url",
        "private",
      ],
      readOnly: [
        "body",
        "from",
        "github_id",
        "reason",
        "unread",
        "github_updated_at",
        "last_read_at",
        "subject_type",
        "url",
        "private",
        references,
      ],
    },
    // GitHub is the source of these, whatever GITHUB_READ_ONLY says: no
    // kind outside `carries` goes back, so the kit puts back every edit.
    {
      type: repositoryFile as TypeDefinition,
      fields: [
        "title",
        "body",
        "repository",
        "path",
        "blob_sha",
        "url",
        "private",
      ],
      readOnly: [
        "title",
        "body",
        "repository",
        "path",
        "blob_sha",
        "url",
        "private",
        inCollection,
        inRepository,
      ],
      derived: ["private"],
    },
    {
      type: directory as TypeDefinition,
      fields: ["title", "repository", "path", "url", "private"],
      readOnly: [
        "title",
        "repository",
        "path",
        "url",
        "private",
        childOf,
        inRepository,
      ],
      derived: ["private"],
    },
  ],
  connections: [
    filesConnection,
    {
      id: references,
      label: "References",
      description:
        "A GitHub notification and the synced issue, pull request or discussion it concerns.",
      cardinality: "many-to-many",
      source_type_constraints: [notificationType],
      target_type_constraints: [issueType, pullRequestType, discussionType],
    },
    {
      id: inRepository,
      label: "In repository",
      description:
        "An issue, discussion, comment, pull request, repository file or directory in the GitHub repository it belongs to.",
      cardinality: "many-to-one",
      source_type_constraints: [
        issueType,
        commentType,
        discussionType,
        pullRequestType,
        repositoryFileType,
        directoryType,
      ],
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
      target_type_constraints: [issueType, discussionType],
    },
    {
      id: childOf,
      cardinality: "many-to-one",
      cascade_on_delete: "cascade",
      source_type_constraints: [commentType, directoryType],
      target_type_constraints: [commentType, directoryType],
    },
    {
      id: inCollection,
      cardinality: "many-to-many",
      source_type_constraints: [repositoryFileType],
      target_type_constraints: [directoryType],
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
      : [issueType, commentType, discussionType].filter(
          (kind) =>
            !readOnly(values.GITHUB_READ_ONLY, kind.slice("github.".length)),
        ),
  checkEnv(values) {
    scopeOf(values.GITHUB_REPOSITORIES);
    filesOf(values.GITHUB_FILES);
    readOnly(values.GITHUB_READ_ONLY);
    starsOn(values.GITHUB_STARS);
    spacingOf(values);
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
            spacingMs: spacingOf(context.env),
          },
      scopeOf(context.env.GITHUB_REPOSITORIES),
      {
        token: context.env.GITHUB_NOTIFICATIONS_TOKEN,
        scopeText: context.env.GITHUB_REPOSITORIES,
      },
      starsOn(context.env.GITHUB_STARS),
      filesOf(context.env.GITHUB_FILES),
    );
  },
  async onChange(change, context) {
    const app = appOf(context.env);
    const handled = await carryDiscussions(change, context, app);
    return handled === undefined ? carry(change, context, app) : handled.entry;
  },
  async remake(change, context) {
    const app = appOf(context.env);
    return (
      (await remakeDiscussions(change, context, app)) ??
      remake(change, context, app)
    );
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
