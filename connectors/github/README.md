# GitHub

Reads the repositories a GitHub App is installed on, their issues and the issues' comments, with sub-issues and blockers, into `github.repository`, `github.issue` and `github.comment` rows at the feed tier, and carries changes made in Marfa to issues and comments back to GitHub, where they appear under the App's name.

## What syncs

- **Repositories**: every repository of every installation of the App, as the person chose them when installing it. A repository is a `github.repository`, read only.
- **Issues**: everything open, and what closed or changed in the last ninety days; an older issue comes in once anything happens to it, or when an issue in the sync names it as its parent or blocker. Each is a `github.issue`, a core task: its title, body, labels and assignees, and its state as the task's status (`pending` while open, `completed` when closed as completed, `canceled` when closed as not planned or a duplicate, with `state_reason` saying which). Pull requests are left out.
- **Comments** on those issues, each a `github.comment`, a core message from its author, in its issue's thread through Marfa's own `in-thread`.
- **Relations**, as connections: `github.sub-issue-of` from an issue to its parent, `github.blocked-by` from an issue to each issue blocking it, and `github.in-repository` from each issue and comment to its repository. A parent or blocker in a public repository the App is not installed on is kept as its address, in `parent_url` or `blocked_by_urls`, until it is. GitHub shows an App nothing of a private repository it is not installed on, not even as the end of a relation, so such a relation is not known at all; nor is one between private repositories under two different installations of the App.

Each row links to GitHub by `github_id`, the GitHub node id of what it is.

## What travels back

Every `github.issue` and `github.comment` on the instance syncs, whoever made it and under whatever source; something meant to stay in Marfa is a core task or message instead. Repositories are read only.

- **Issues:** the title, body, labels and assignees, and the status: `completed` closes the issue as completed, `canceled` as not planned, and anything else reopens a closed one; a status GitHub has no word for, such as in progress, stays in Marfa on an open issue. An assignee GitHub will not assign is named in the run.
- **An issue made in Marfa** is created in the repository its `github.in-repository` names; without one it is not sent, and the run says why. What the App makes ends with a mark, an HTML comment GitHub's page does not show and the connector leaves out of what it reads, so where a run made it and lost GitHub's answer, the next finds it by its mark rather than making another, and brings it to what the row says by then. A row trashed before that answer came cannot take the link, so what GitHub made comes in as its own row, and the run says so.
- **Relations:** a `github.sub-issue-of` or `github.blocked-by` drawn or removed in Marfa is made or removed on GitHub; one GitHub refuses, such as a sub-issue across two owners, is taken back in Marfa and named. A repository or thread changed in Marfa is put back, since GitHub cannot move either that way.
- **Comments:** one made in Marfa in an issue's thread, through `in-thread`, is posted there, and its edits follow; its `from` becomes the App's.
- **A trash closes, never deletes.** Trashing an open issue closes it as not planned, and one already closed stays as it is; restoring it from the bin sets its state again as its status says, so what the trash closed reopens; a reopen, an edit or a comment on GitHub while it is in the bin brings it back, as GitHub has it; a purge is remembered, and it stays closed on GitHub. A trash that came from another row's is not carried. A comment follows the ordinary rule: a trash deletes it on GitHub, a restore makes it again, and one deleted on GitHub is archived at the daily check.
- **What GitHub refuses**, such as a change in an archived repository or a label too long, is named in the run and left unsent; the rest of the run goes on, and relations drawn beside it are still made.
- **Lost access** changes nothing: a change to a repository the App can no longer reach, through an uninstalled or suspended installation or a repository taken from it, or while GitHub's rate limit is spent, waits and is named in the run, and is carried once access is back.

`GITHUB_READ_ONLY=true` runs it read only as a whole: nothing goes back, a change made in Marfa to a synced field or connection is put back and named, and the setup asks GitHub only to read.

## How changes are noticed

A scheduled run lists each repository's issues whole, open and within the window, page by page, asking each page with the ETag it last answered: a page that did not change answers 304, which costs nothing against GitHub's rate limit. A new comment moves its issue's time; an edited comment, a sub-issue or a blocker does not, which is why the listing is read whole rather than since a time, and the relations of each issue that changed are asked of GitHub's GraphQL API. Comments are read since the last run.

GitHub answers 304 only to the installation token that was answered the ETag, and a token lasts an hour. Run the connector with `--every`, which keeps its tokens between runs: a quiet repository then costs one full listing an hour, a request per hundred issues, and nothing between. Run with `--once`, each run lists everything afresh. An installation's rate limit is 5,000 requests an hour. A first sync reads each repository's open and recently closed issues and all its comments, pull requests' included, a request per hundred of each: 500 issues and 2,000 comments are about 30 requests. The daily check reads the comments whole again. A run stops before an installation's limit runs low, keeping what it did, and the repositories it did not reach wait for the next.

Once a day, a scheduled run also asks GitHub about each row it no longer lists. Only GitHub saying so archives anything:

- An issue GitHub says was deleted (410) is archived; one it says moved to another repository (301) is archived, and the run says so, since it arrives there as a new row.
- A comment gone from a repository GitHub still reads is archived.
- A repository taken out of the App's installation has its rows archived; they come back if it is added again.
- An App uninstalled, or its installation suspended or refusing it, a repository that stops answering, or one whose issues are turned off, changes nothing: the run says so, and the rows stay as they are.
- The daily check also writes any comment a run missed.

## Setting it up

A GitHub App, registered from the manifest the connector serves:

1. Mint the connector's key, as `template/README.md` says, with `--type-permission` for the three types, `--edge-permission` for `github.in-repository`, `github.sub-issue-of`, `github.blocked-by` and `in-thread`, and `--metadata-permission types=write --metadata-permission edge_types=write`.
2. With `MARFA_URL`, `MARFA_KEY` and, where the instance has one, its public address as `GITHUB_PUBLIC_URL`, run `node dist/main.js --setup <file>`. Open the address it logs, continue to GitHub, create the App, named Marfa Connectors unless `GITHUB_APP_NAME` names another (GitHub holds each name once, so a second person's App needs its own), and install it on the repositories to sync from the address the setup logs next. For an organization's App, set `GITHUB_ORGANIZATION`.
3. Move the three secrets the file holds into the secret store and delete the file.

Without a public address the App's webhook is off, and the connector notices changes by polling alone. Run the setup again with `GITHUB_PUBLIC_URL` and the App's two secrets in the environment to point the App's webhook at the instance with a new secret, as when the instance moves. Each setup makes a new webhook endpoint; retire the one it replaced with `marfa connectors endpoints retire`.

## Environment

- `GITHUB_APP_ID`: the App's id.
- `GITHUB_PRIVATE_KEY`: the App's private key, a secret. Installation tokens are made from it for an hour at a time and kept out of every log.
- `GITHUB_WEBHOOK_SECRET`: the secret GitHub signs deliveries with, a secret.
- `GITHUB_READ_ONLY`: `true` for a read-only connector, optional.
- `GITHUB_PUBLIC_URL`, `GITHUB_ORGANIZATION`, `GITHUB_APP_NAME`: for the setup, optional.
- `GITHUB_API_URL`: optional, for a stub of the API; GitHub's otherwise. GitHub Enterprise Server is not tested.

The key and the run are as `template/README.md` says.
