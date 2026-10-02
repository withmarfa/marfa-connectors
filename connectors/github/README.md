# GitHub

Reads the repositories a GitHub App is installed on, their issues and the issues' comments, with sub-issues and blockers, into `github.repository`, `github.issue` and `github.comment` rows at the feed tier, and carries changes made in Marfa to issues and comments back to GitHub, where they appear under the App's name.

## What syncs

- **Repositories**: every repository of every installation of the App, as the person chose them when installing it, or, with `GITHUB_REPOSITORIES`, those of them it names, so the App can see more than is synced. A repository is a `github.repository`, read only. One synced before and left out of `GITHUB_REPOSITORIES` since is paused: nothing of it is read or written and its rows are left as they are, bar `private`, which follows its last known visibility, a change made to them in Marfa waits and is named, and a relation drawn to one of its issues is taken back and named; named again, it is taken up where it stopped. A setting changes nothing on its own, so a typo or a rename on GitHub pauses a repository rather than archiving it. An entry that no installation shows is named in each run.
- **Issues**: everything open, and what closed or changed in the last ninety days; an older issue comes in once anything happens to it, or when an issue in the sync names it as its parent or blocker. Each is a `github.issue`, a core task: its title, body, labels and assignees, and its state as the task's status (`pending` while open, `completed` when closed as completed, `canceled` when closed as not planned or a duplicate, with `state_reason` saying which). Pull requests are left out.
- **Comments** on those issues, each a `github.comment`, a core message from its author, in its issue's thread through Marfa's own `in-thread`.
- **Relations**, as connections: `github.sub-issue-of` from an issue to its parent, `github.blocked-by` from an issue to each issue blocking it, and `github.in-repository` from each issue and comment to its repository. A parent or blocker in a public repository the connector does not sync, because the App is not installed on it or `GITHUB_REPOSITORIES` leaves it out, is kept as its address, in `parent_url` or `blocked_by_urls`, until it is synced. The connector's tokens reach only the repositories it syncs, so GitHub shows it nothing of a private repository it does not sync, not even as the end of a relation: such a relation is not known at all, whether the App is not installed there, `GITHUB_REPOSITORIES` leaves the repository out, or it is under another installation of the App. A relation to an issue in a repository synced before and left out since stays, as that repository's rows do.

Each row links to GitHub by `github_id`, the GitHub node id of what it is.

## What travels back

Every `github.issue` and `github.comment` on the instance syncs, whoever made it and under whatever source; something meant to stay in Marfa is a core task or message instead. Repositories are read only. A row made in Marfa is sent as a new issue or comment; one made by hand with a `github_id` of its own is never taken for what GitHub has, so a relation or thread drawn to it waits.

Every write finds its target by the node id agreed with GitHub, asking GitHub where that issue or comment is now, never by a row's `repository` or `number`: a repository renamed or an issue transferred between repositories the App reads is followed, and an old name taken by another repository changes nothing. A target in a repository the connector does not sync or has paused is not written: the change waits and is named in the run. One the App can no longer find under any installation, while every synced repository still reads, is not sent and is settled, and the run names it: unlike a change GitHub refuses, which waits until the row changes, there is nowhere left to send it, and the daily check, or a delivery naming it, archives the row. While any synced repository is out of reach, such a change waits instead. A relation is the exception: one drawn to an issue the App may not relate to, for any of those reasons, is taken back in Marfa and named, rather than waiting.

Each `github.issue` and `github.comment` carries a read-only `private`, whether its repository is private on GitHub, as of the last scheduled run; the repository row carries the same. A change of a repository's visibility is put on every issue and comment held under it on the next scheduled run, with no read of GitHub and whether or not GitHub changed them, and so is the first run after an upgrade that brought the field. A repository the App can no longer read has its rows marked private, since its visibility is not known. A webhook-driven run marks what it reads from the repository's visibility then. A change in `private` is not activity on an issue: it brings no trashed issue back. A row in the bin takes the value when it leaves it, by a restore or by GitHub's activity, since the instance refuses a write to a row in the bin. A comment whose issue was transferred to a repository the App does not sync keeps its original repository's value. The field is a marker and no more: the connector does not stop anyone copying a row's contents elsewhere, and Marfa gives a key access by type and connection, not by this field, so anyone able to write `github.issue` rows can still create an issue in a public repository from a private one's row. Read it before copying. The field is new to the two types on the instance, and a connector's key cannot add it, since replacing a type takes `schema.write`: before the first start of the new version, an operator replaces each, `marfa types update github.issue --file connectors/github/src/github.issue.json` and the same for `github.comment`.

- **Issues:** the title, body, labels and assignees, and the status: `completed` closes the issue as completed, `canceled` as not planned, and anything else reopens a closed one; a status GitHub has no word for, such as in progress, stays in Marfa on an open issue. An assignee GitHub will not assign is named in the run.
- **An issue made in Marfa** is created in the repository its `github.in-repository` names; without one it is not sent, and the run says why. What the App makes ends with a mark, an HTML comment GitHub's page does not show and the connector leaves out of what it reads, so where a run made it and lost GitHub's answer, the next finds it by its mark rather than making another, and brings it to what the row says by then. A row trashed before that answer came cannot take the link, so what GitHub made comes in as its own row, and the run says so.
- **Relations:** a `github.sub-issue-of` or `github.blocked-by` drawn or removed in Marfa is made or removed on GitHub; one GitHub refuses, such as a sub-issue across two owners, is taken back in Marfa and named. A repository or thread changed in Marfa is put back, since GitHub cannot move either that way.
- **Comments:** one made in Marfa in an issue's thread, through `in-thread`, is posted there, and its edits follow; its `from` becomes the App's. Only comments the App wrote take edits from Marfa: an edit to anyone else's is put back, and the run says it was not sent.
- **A trash closes, never deletes.** Trashing an open issue closes it as not planned, and one already closed stays as it is; restoring it from the bin sets its state again as its status says, so what the trash closed reopens; a reopen, an edit or a comment on GitHub while it is in the bin brings it back, as GitHub has it; a purge is remembered, and it stays closed on GitHub. A trash that came from another row's is not carried. A comment the App wrote follows the ordinary rule: a trash deletes it on GitHub, a restore makes it again, and one deleted on GitHub is archived when its delivery arrives, or at the daily check. Anyone else's comment stays on GitHub when its row is trashed, the row stays in the bin, and the run says so; one GitHub lost is not posted again under the App's name.
- **What GitHub refuses**, such as a change in an archived repository or a label too long, is named in the run and left unsent; the rest of the run goes on, and relations drawn beside it are still made.
- **Lost access** changes nothing: a change to a repository the App can no longer reach, through an uninstalled or suspended installation or a repository taken from it, or while GitHub's rate limit is spent, waits and is named in the run, and is carried once access is back.

`GITHUB_READ_ONLY=true` runs it read only as a whole: nothing goes back, a change made in Marfa to a synced field or connection is put back and named, and the setup asks GitHub only to read.

## How changes are noticed

A scheduled run lists each repository's issues whole, open and within the window, page by page, asking each page with the ETag it last answered: a page that did not change answers 304, which costs nothing against GitHub's rate limit. A new comment moves its issue's time; an edited comment, a sub-issue or a blocker does not, which is why the listing is read whole rather than since a time, and the relations of each issue that changed are asked of GitHub's GraphQL API. Comments are read since the last run.

GitHub's documentation says an authorized request that answers 304 does not count against the primary rate limit. The ETags are kept in the connector's state, so a run asks with the ETag the last one received; the documentation does not say whether a 304 holds across installation tokens, which last an hour, and the connector keeps its tokens between runs only under `--every`, so a `--once` run may list afresh. A token is minted for the repositories it reaches, so a change to which are synced or paused asks for a new one. An installation's rate limit is 5,000 requests an hour. A first sync reads each repository's open and recently closed issues and all its comments, pull requests' included, a request per hundred of each: 500 issues and 2,000 comments are about 30 requests. The daily check reads the comments whole again. A run stops before an installation's limit runs low, keeping what it did, and the repositories it did not reach wait for the next.

With the App's webhook pointed at the instance, run the connector as `--every 1h --look-every 10s`: GitHub's deliveries for issues, comments, sub-issues and blockers each name what changed, and within seconds a run lists the App's installations and each one's repositories, then asks GitHub for those issues and comments by node id, with the issues at the other end of their relations, and reads no repository's listings, leaving their cursors for the next scheduled run. A delivery naming an issue or comment GitHub no longer has, in a repository the App still reads, has it asked after as the daily check asks. A change to an installation or a repository has the next run read everything. Deliveries are checked against `GITHUB_WEBHOOK_SECRET`, and one that fails is rejected and counted in the run's report. GitHub does not send a delivery again on its own, so the hourly run still reads every listing.

Once a day, a scheduled run also asks GitHub about each row it no longer lists. Only GitHub saying so archives anything:

- An issue GitHub says was deleted (410) is archived; one it says moved to another repository (301) is archived, and the run says so, since it arrives there as a new row.
- A comment gone from a repository GitHub still reads is archived.
- A repository taken out of the App's installation has its rows archived; they come back if it is added again.
- An App uninstalled, or its installation suspended or refusing it, a repository that stops answering, or one whose issues are turned off, changes nothing: the run says so, and the rows stay as they are.
- The daily check also writes any comment a run missed.

## Setting it up

A GitHub App, registered from the manifest the connector serves:

1. Mint the connector's key, as `template/README.md` says, with `--type-permission` for the three types, `--edge-permission` for `github.in-repository`, `github.sub-issue-of`, `github.blocked-by` and `in-thread`, and `--metadata-permission types=write --metadata-permission edge_types=write`, which it needs only until its first start has registered them; the kit then says how to narrow the key.
2. With `MARFA_URL`, `MARFA_KEY` and, where the instance has one, its public address as `GITHUB_PUBLIC_URL`, run `node dist/main.js --setup <file>`, naming a file outside the checkout and every other git working tree, such as one in the home directory: setup refuses a file in a folder that holds a `.git` or under one. Open the address it logs, continue to GitHub, create the App, named Marfa Connectors unless `GITHUB_APP_NAME` names another (GitHub holds each name once, so a second person's App needs its own), and install it on the repositories to sync from the address the setup logs next. For an organization's App, set `GITHUB_ORGANIZATION`.
3. Move the three secrets the file holds into the secret store and delete the file.

Without a public address the App's webhook is off, and the connector notices changes by polling alone. Run the setup again with `GITHUB_PUBLIC_URL` and the App's two secrets in the environment to point the App's webhook at the instance with a new secret, as when the instance moves. Each setup makes a new webhook endpoint, labeled with when it was set up, and names its id; retire the one it replaced with `marfa connectors endpoints retire <connector-id> <endpoint-id>`. A setup that fails retires the endpoint it made, or names it with the command to retire it by hand where the instance would not.

## Environment

- `GITHUB_APP_ID`: the App's id.
- `GITHUB_PRIVATE_KEY`: the App's private key, a secret. Installation tokens are made from it for an hour at a time, each reaching only what it is for, as below, and kept out of every log.
- `GITHUB_WEBHOOK_SECRET`: the secret GitHub signs deliveries with, a secret.
- `GITHUB_READ_ONLY`: `true` for a read-only connector, optional.
- `GITHUB_REPOSITORIES`: the repositories to sync, as `owner/repo` or `owner/*`, set apart by commas or spaces, in any case; optional, every repository the App sees otherwise. A malformed entry stops the start.
- `GITHUB_PUBLIC_URL`, `GITHUB_ORGANIZATION`, `GITHUB_APP_NAME`: for the setup, optional. The public address's own path, where the instance sits behind a prefix, is kept before the webhook's.
- `GITHUB_API_URL`: optional, for a stub of the API; GitHub's otherwise. GitHub Enterprise Server is not tested.

The key and the run are as `template/README.md` says.

## Its tokens

Each installation token the connector asks GitHub for reaches no more than its use needs, naming repositories by GitHub's id, so a rename changes nothing:

- One lists which repositories an installation holds, and reads nothing else.
- One reads the issues and comments of the repositories synced, and of those paused, so their relations stay.
- One finds where an issue or comment named by a change sits, reading only, across the repositories the connector holds under the installation. Where GitHub will not name one of them, as for a repository taken from the installation since the last scheduled run, or one whose id is not yet recorded, it reaches the whole installation instead; a change is still carried only into a synced repository.
- One for each change made in Marfa writes issues and comments only in the synced repositories that change touches: its own, and that of the issue at the other end of a relation it draws or removes. A paused repository is never among them. Where GitHub will not mint one, as for a repository gone from the installation since the last scheduled run, only the changes touching that repository wait. A change in a repository whose id is not yet recorded waits for the next scheduled run, which records it, and the run says so. With `GITHUB_READ_ONLY` none is asked for.

GitHub names at most 500 repositories to a token, so past that many synced or paused under one installation, the token that reads reaches every repository of it, and the run says so; a token for a change names far fewer.

A token GitHub refuses after it was kept, as when it is revoked, is replaced and the request sent once more.

A clock out of step with GitHub's by up to ten minutes is allowed for: what GitHub's answer says of its time is used to sign the App's requests from then on. Past ten minutes the connector asks GitHub nothing, and each run says so until the clock is set right; a change made in Marfa meanwhile waits.
