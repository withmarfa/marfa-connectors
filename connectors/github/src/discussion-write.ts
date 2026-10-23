import { GraphqlResponseError } from "@octokit/graphql";
import {
  Declined,
  Refused,
  Unreachable,
  type Change,
  type Entry,
  type Item,
} from "@withmarfa/connector";
import {
  childOf,
  commentType,
  discussionCommentEntry,
  discussionEntry,
  discussionType,
  inRepository,
  inThread,
  unmarked,
  type Discussion,
  type DiscussionComment,
} from "./entries.js";
import {
  addDiscussionComment,
  closeDiscussion,
  commentsOf,
  createDiscussion,
  deleteDiscussionComment,
  discussionCategories,
  discussionCommentsByNode,
  DiscussionsRefused,
  discussionsByNode,
  discussionsRefusal,
  listDiscussions,
  reopenDiscussion,
  updateDiscussion,
  updateDiscussionComment,
} from "./discussions.js";
import { status, type App, type Client } from "./github.js";
import {
  allKept,
  binnedUnanswered,
  botOf,
  goneOrWaits,
  linkMade,
  linkRefused,
  looker,
  looking,
  margin,
  marked,
  placeIn,
  refusedApp,
  refusedOrWaits,
  repositoryAt,
  text,
  unlisted,
  waiting,
  type Context,
  type Place,
} from "./write.js";
import { everywhere } from "./unsettled.js";

const reasons = {
  resolved: "RESOLVED",
  outdated: "OUTDATED",
  duplicate: "DUPLICATE",
} as const;

/** The reason a row asks to close for: one GitHub offers, or resolved. */
function closing(item: Item): (typeof reasons)[keyof typeof reasons] {
  const asked = text(item, "state_reason")?.toLowerCase();
  return asked !== undefined && asked in reasons
    ? reasons[asked as keyof typeof reasons]
    : "RESOLVED";
}

function discussionAnswer(context: Context, discussion: Discussion): Entry {
  return discussionEntry(
    discussion,
    allKept(context)[discussion.repository.node]?.private,
  );
}

function commentAnswer(context: Context, comment: DiscussionComment): Entry {
  return discussionCommentEntry(
    comment,
    allKept(context)[comment.repository.node]?.private,
  );
}

/** Asked of each installation the sync uses, with the token that reads
 *  Discussions. A node none of them shows is gone; where one refused the
 *  App Discussions, the node may be there, so the change waits. */
async function seekIn<T>(
  context: Context,
  app: App,
  item: Item,
  ask: (octokit: Client) => Promise<T | undefined>,
): Promise<T | undefined> {
  const installations = new Set(
    Object.values(allKept(context)).map((one) => one.installation),
  );
  let refused: string | undefined;
  for (const installation of installations) {
    try {
      const found = await ask(
        looker(context, app, installation, "discussions"),
      );
      if (found !== undefined) return found;
    } catch (error) {
      const why = discussionsRefusal(error);
      if (why !== undefined) {
        refused = why;
        continue;
      }
      if (refusedApp(error)) {
        refused = "the App's installation refused it";
        continue;
      }
      throw error;
    }
  }
  if (refused !== undefined) {
    throw new Unreachable(
      `GitHub refused the App its Discussions (${refused}), so the change to ${item.id} waits`,
    );
  }
  return undefined;
}

async function discussionAt(
  context: Context,
  app: App,
  item: Item,
  node: string,
): Promise<{ place: Place; discussion: Discussion } | undefined> {
  const discussion = await seekIn(
    context,
    app,
    item,
    async (octokit) => (await discussionsByNode(octokit, [node]))[0],
  );
  return discussion === undefined
    ? undefined
    : {
        place: placeIn(
          context,
          app,
          discussion.repository,
          "discussions-write",
        ),
        discussion,
      };
}

async function commentAt(
  context: Context,
  app: App,
  item: Item,
  node: string,
): Promise<{ place: Place; comment: DiscussionComment } | undefined> {
  const comment = await seekIn(
    context,
    app,
    item,
    async (octokit) => (await discussionCommentsByNode(octokit, [node]))[0],
  );
  return comment === undefined
    ? undefined
    : {
        place: placeIn(context, app, comment.repository, "discussions-write"),
        comment,
      };
}

/** A refusal of a Discussions write, as a refused change rather than a
 *  failed run. */
async function refused(
  error: unknown,
  place: Place,
  what: string,
): Promise<never> {
  if (error instanceof DiscussionsRefused) throw new Refused(error.message);
  return refusedOrWaits(error, place.octokit, place, what);
}

async function discussionsMadeSince(
  place: Place,
  app: App,
  signal: AbortSignal,
  attempted: string,
): Promise<{ node_id: string; body: string; discussion: Discussion }[]> {
  // GitHub takes no idempotency key: find what the first try made.
  const since = new Date(Date.parse(attempted) - margin).toISOString();
  const bot = await botOf(app, signal);
  const listed = await listDiscussions(
    place.octokit,
    place.owner,
    place.repo,
    since,
  );
  return listed.found
    .filter((one) => one.author === bot && one.createdAt >= since)
    .map((one) => ({ node_id: one.node, body: one.body, discussion: one }));
}

async function commentsMadeSince(
  place: Place,
  app: App,
  signal: AbortSignal,
  discussion: string,
  attempted: string,
): Promise<{ node_id: string; body: string; comment: DiscussionComment }[]> {
  const since = new Date(Date.parse(attempted) - margin).toISOString();
  const bot = await botOf(app, signal);
  const read = await commentsOf(place.octokit, {
    node: discussion,
    repository: place.repository,
  });
  return (read ?? [])
    .filter((one) => one.author === bot && one.createdAt >= since)
    .map((one) => ({ node_id: one.node, body: one.body, comment: one }));
}

type Handled = { entry: Entry | undefined } | undefined;

/** Which kind of thread a comment is in: where the row was placed, or for a
 *  row with no placement, which kind its node is. An issue comment goes on to
 *  the issue path unasked. */
async function threadIsDiscussion(
  change: Change,
  context: Context,
  app: App,
): Promise<boolean> {
  const { item } = change;
  const thread =
    change.kind === "created"
      ? change.connections?.[inThread]?.added[0]
      : change.placement?.[inThread]?.[0];
  if (thread !== undefined) return thread.type === discussionType;
  if (change.kind === "created") return false;
  const node = text(item, "github_id");
  if (node === undefined) return false;
  return (await commentAt(context, app, item, node)) !== undefined;
}

/** Carries a change to a discussion or to a comment on one; nothing for any
 *  other row, which the issue path carries. */
export async function carryDiscussions(
  change: Change,
  context: Context,
  app: App,
): Promise<Handled> {
  const { item } = change;
  if (item.type === discussionType) {
    return {
      entry: await waiting(change, () => carryDiscussion(change, context, app)),
    };
  }
  if (item.type !== commentType) return undefined;
  return waiting(change, async (): Promise<Handled> => {
    if (!(await threadIsDiscussion(change, context, app))) return undefined;
    return { entry: await carryComment(change, context, app) };
  });
}

async function carryDiscussion(
  change: Change,
  context: Context,
  app: App,
): Promise<Entry | undefined> {
  const { item } = change;
  if (change.kind === "created") return createRow(change, context, app);
  const node = text(item, "github_id");
  if (node === undefined) {
    binnedUnanswered(context, item);
    return undefined;
  }
  // Binning a discussion changes nothing on GitHub, which has no bin.
  if (change.kind === "trashed" || change.kind === "purged") return undefined;
  const patch: { title?: string; body?: string } = {};
  for (const field of ["title", "body"] as const) {
    if (change.changed.has(field)) patch[field] = text(item, field) ?? "";
  }
  const stated =
    change.changed.has("status") || change.changed.has("state_reason");
  if (Object.keys(patch).length === 0 && !stated) return undefined;
  if (patch.title === "") {
    throw new Refused(`${item.id} has no title, which GitHub requires`);
  }
  const found = await discussionAt(context, app, item, node);
  if (found === undefined) {
    await goneOrWaits(context, app, change, "discussions");
    return undefined;
  }
  const { place } = found;
  let current = found.discussion;
  try {
    if (Object.keys(patch).length > 0) {
      current = await updateDiscussion(place.octokit, node, patch);
    }
    if (stated) {
      if (text(item, "status") === "closed") {
        const reason = closing(item);
        if (current.open || current.reason?.toUpperCase() !== reason) {
          current = await closeDiscussion(place.octokit, node, reason);
        }
      } else if (!current.open) {
        current = await reopenDiscussion(place.octokit, node);
      }
    }
  } catch (error) {
    return refused(
      error,
      place,
      `the change to ${place.owner}/${place.repo}#${String(current.number)}`,
    );
  }
  return discussionAnswer(context, current);
}

async function createRow(
  change: Change,
  context: Context,
  app: App,
): Promise<Entry | undefined> {
  const { item } = change;
  const repository = change.connections?.[inRepository]?.added[0];
  const node =
    repository === undefined ? undefined : text(repository, "github_id");
  if (node === undefined) {
    context.log.condition(
      `discussion-unplaced:${item.id}`,
      `${item.id} names no repository the App reads, so it is not sent to GitHub; connect it to one with ${inRepository}`,
    );
    return undefined;
  }
  const title = text(item, "title") ?? "";
  if (title === "") {
    throw new Refused(`${item.id} has no title, which GitHub requires`);
  }
  const { attempted } = change;
  let where: Place;
  if (attempted === undefined) {
    where = await repositoryAt(context, app, node, "discussions-write");
  } else {
    let made: { discussion: Discussion } | undefined;
    [where, made] = await looking(context, item, node, async () => {
      const at = await repositoryAt(context, app, node, "discussions-write");
      return [
        at,
        await linkMade(
          context,
          item,
          await discussionsMadeSince(at, app, context.signal, attempted),
        ),
      ] as const;
    });
    if (made !== undefined) {
      return place(change, context, where, made.discussion, true);
    }
  }
  const { octokit, owner, repo } = where;
  const wanted = text(item, "category")?.trim() ?? "";
  let categories: { id: string; name: string }[];
  try {
    categories = await discussionCategories(octokit, owner, repo);
  } catch (error) {
    return refused(error, where, `the categories of ${owner}/${repo}`);
  }
  const chosen =
    categories.find((one) => one.name === wanted) ??
    categories.find(
      (one) => wanted !== "" && one.name.toLowerCase() === wanted.toLowerCase(),
    );
  if (chosen === undefined) {
    const names = categories.map((one) => one.name).join(", ");
    throw new Refused(
      categories.length === 0
        ? `${owner}/${repo} has no discussion categories, so ${item.id} cannot be sent; turn Discussions on there`
        : `${item.id} ${wanted === "" ? "has no category" : `names the category "${wanted}", which ${owner}/${repo} does not have`}; set its category to one of ${names}`,
    );
  }
  const sent = new Date().toISOString();
  let posted: Discussion;
  try {
    posted = await createDiscussion(octokit, {
      repositoryId: node,
      categoryId: chosen.id,
      title,
      body: marked(item),
    });
  } catch (error) {
    if ((status(error) ?? 0) >= 500) {
      const landed = await looking(context, item, node, async () =>
        linkMade(
          context,
          item,
          await discussionsMadeSince(where, app, context.signal, sent),
        ),
      );
      if (landed !== undefined) {
        return place(change, context, where, landed.discussion, true);
      }
      throw unlisted(context, item, node);
    }
    return refused(error, where, `the new discussion in ${owner}/${repo}`);
  }
  await context.setLink(item, posted.node).catch(linkRefused);
  return place(change, context, where, posted, false);
}

/** Brings a discussion a create made to what the row says: a retry finds one
 *  made before the row changed, and a row can be made closed. */
async function place(
  change: Change,
  context: Context,
  where: Place,
  made: Discussion,
  found: boolean,
): Promise<Entry> {
  const { item } = change;
  const { octokit, owner, repo } = where;
  const patch: { title?: string; body?: string } = {};
  if (found) {
    const title = text(item, "title") ?? "";
    const body = text(item, "body") ?? "";
    if (title !== made.title) patch.title = title;
    if (body !== unmarked(made.body)) patch.body = body;
  }
  let current = made;
  try {
    if (Object.keys(patch).length > 0) {
      current = await updateDiscussion(octokit, made.node, patch);
    }
    if (
      text(item, "status") === "closed" &&
      (current.open || current.reason?.toUpperCase() !== closing(item))
    ) {
      current = await closeDiscussion(octokit, made.node, closing(item));
    }
  } catch (error) {
    return refused(
      error,
      where,
      `the change to ${owner}/${repo}#${String(made.number)}`,
    );
  }
  return discussionAnswer(context, current);
}

async function carryComment(
  change: Change,
  context: Context,
  app: App,
): Promise<Entry | undefined> {
  const { item } = change;
  if (change.kind === "created") return createComment(change, context, app);
  const node = text(item, "github_id");
  if (node === undefined) {
    binnedUnanswered(context, item);
    return undefined;
  }
  const binned = change.kind === "trashed" || change.kind === "purged";
  if (!binned && !change.changed.has("body")) return undefined;
  const found = await commentAt(context, app, item, node);
  if (found === undefined) {
    await goneOrWaits(context, app, change, "discussions");
    return undefined;
  }
  const { octokit, owner, repo } = found.place;
  if (found.comment.author !== (await botOf(app, context.signal))) {
    throw new Declined(
      binned
        ? `${item.id} was written on GitHub by someone other than the App, so it stays there though it is in the bin in Marfa`
        : `${item.id} was written on GitHub by someone other than the App, so its edit in Marfa is not sent`,
    );
  }
  try {
    if (binned) {
      await deleteDiscussionComment(octokit, node, { owner, repo });
      return undefined;
    }
    return commentAnswer(
      context,
      await updateDiscussionComment(octokit, node, text(item, "body") ?? ""),
    );
  } catch (error) {
    if (
      binned &&
      error instanceof GraphqlResponseError &&
      error.errors?.every((one) => one.type === "NOT_FOUND") === true
    ) {
      throw new Unreachable(
        `GitHub would not delete ${item.id}, though it still shows it, so its trash waits`,
      );
    }
    return refused(error, found.place, `the change to ${item.id}`);
  }
}

async function createComment(
  change: Change,
  context: Context,
  app: App,
): Promise<Entry | undefined> {
  const { item } = change;
  const thread =
    change.connections?.[inThread]?.added[0] ??
    change.placement?.[inThread]?.[0];
  const discussionNode =
    thread === undefined ? undefined : text(thread, "github_id");
  if (discussionNode === undefined) {
    context.log.condition(
      `comment-unplaced:${item.id}`,
      `${item.id} is in no discussion's thread the App reads, so it is not sent to GitHub; put it in one with ${inThread}`,
    );
    return undefined;
  }
  const answering =
    change.connections?.[childOf]?.added[0] ?? change.placement?.[childOf]?.[0];
  const replyNode =
    answering === undefined ? undefined : text(answering, "github_id");
  const { attempted } = change;
  const found =
    attempted === undefined
      ? await discussionAt(context, app, item, discussionNode)
      : await looking(context, item, everywhere, () =>
          discussionAt(context, app, item, discussionNode),
        );
  if (found === undefined) {
    await goneOrWaits(
      context,
      app,
      change,
      "discussions",
      thread === undefined ? undefined : text(thread, "repository"),
    );
    return undefined;
  }
  const { octokit, repository } = found.place;
  const body = text(item, "body") ?? "";
  let made =
    attempted === undefined
      ? undefined
      : await looking(context, item, repository.node, async () =>
          linkMade(
            context,
            item,
            await commentsMadeSince(
              found.place,
              app,
              context.signal,
              discussionNode,
              attempted,
            ),
          ),
        );
  let comment = made?.comment;
  if (comment === undefined) {
    const sent = new Date().toISOString();
    let linked = false;
    try {
      comment = await addDiscussionComment(octokit, {
        discussionId: discussionNode,
        ...(replyNode !== undefined && { replyToId: replyNode }),
        body: marked(item),
      });
    } catch (error) {
      if ((status(error) ?? 0) < 500) {
        return refused(
          error,
          found.place,
          `${item.id} on ${found.discussion.url}`,
        );
      }
      made = await looking(context, item, repository.node, async () =>
        linkMade(
          context,
          item,
          await commentsMadeSince(
            found.place,
            app,
            context.signal,
            discussionNode,
            sent,
          ),
        ),
      );
      if (made === undefined) throw unlisted(context, item, repository.node);
      comment = made.comment;
      linked = true;
    }
    if (!linked) {
      await context.setLink(item, comment.node).catch(linkRefused);
    }
  }
  if (unmarked(comment.body) !== body) {
    try {
      comment = await updateDiscussionComment(octokit, comment.node, body);
    } catch (error) {
      return refused(error, found.place, `the change to ${item.id}`);
    }
  }
  return commentAnswer(context, comment);
}

/** Posts a comment again that is gone from GitHub, under the App's name only
 *  where the App wrote it. `undefined` where the row is not a discussion
 *  comment placed in a discussion. */
export async function remakeDiscussions(
  change: Change,
  context: Context,
  app: App,
): Promise<boolean | undefined> {
  const { item } = change;
  if (item.type !== commentType) return undefined;
  if (change.placement?.[inThread]?.[0]?.type !== discussionType) {
    return undefined;
  }
  const node = text(item, "github_id");
  if (node === undefined) return false;
  return waiting(change, async () => {
    if ((await commentAt(context, app, item, node)) !== undefined) {
      return false;
    }
    if (change.unagreed?.has("from") === true) {
      throw new Unreachable(
        `${item.id}'s author in Marfa is not the one GitHub gave, and putting it back failed, so its restore waits`,
      );
    }
    if (text(item, "from") !== (await botOf(app, context.signal))) {
      throw new Declined(
        `${item.id} is gone from GitHub and was written there by someone other than the App, so it is not posted again under the App's name`,
      );
    }
    const made = await createComment(
      { ...change, kind: "created" },
      context,
      app,
    );
    if (made === undefined) {
      throw new Unreachable(
        `${item.id} could not be made again on GitHub, so its restore waits`,
      );
    }
    return true;
  });
}
