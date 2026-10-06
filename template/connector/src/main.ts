import {
  defineConnector,
  LinkTaken,
  main,
  Refused,
  Unreachable,
  type Entry,
  type TypeDefinition,
} from "@withmarfa/connector";
import exampleItem from "./example.item.json" with { type: "json" };

interface VendorItem {
  id: string;
  title?: string;
  url?: string;
  note?: string;
  created: string;
  updated?: string;
  deleted?: boolean;
}

const defaultTimeoutMs = 30_000;

class NotTaken extends Error {
  constructor(readonly status: number | undefined) {
    super(
      status === undefined
        ? "the example vendor did not answer"
        : `the example vendor answered ${String(status)}`,
    );
  }
}

// What a write the vendor did not take means for the change: one that can
// pass by itself waits for the next run, and one that will not waits for the
// row to change. A refused token stays thrown, and fails the run.
function undelivered(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return error;
  if (error instanceof LinkTaken) return new Refused(error.message);
  if (!(error instanceof NotTaken)) return error;
  const { status } = error;
  return status === undefined || status === 429 || status >= 500
    ? new Unreachable(error.message, { scope: "the example vendor" })
    : new Refused(error.message);
}

interface VendorEnv {
  readonly EXAMPLE_URL: string;
  readonly EXAMPLE_TOKEN: string;
  readonly EXAMPLE_TIMEOUT_MS?: string | undefined;
}

// `new URL(path, base)` drops the base's last segment unless the base ends in
// a slash, so `https://v.example.com/api` plus `items` would reach `/items`.
function address(base: string, path: string): URL {
  return new URL(path, base.endsWith("/") ? base : `${base}/`);
}

// Past this a timer cannot hold the limit: `AbortSignal.timeout` throws, or
// fires after one millisecond.
const longestTimeoutMs = 2_147_483_647;

function timeoutOf(value: string | undefined): number {
  if (value === undefined) return defaultTimeoutMs;
  const milliseconds = Number(value);
  if (
    !Number.isInteger(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > longestTimeoutMs
  ) {
    throw new Error(
      `EXAMPLE_TIMEOUT_MS is not a whole number of milliseconds from 1 to ${String(longestTimeoutMs)}`,
    );
  }
  return milliseconds;
}

function checkAddress(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("EXAMPLE_URL is not an address");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("EXAMPLE_URL is not an http or https address");
  }
}

// A stop is the kit's, and passes as it is; any other failure to get an answer,
// a timeout included, is the vendor not answering.
function unanswered(error: unknown, signal: AbortSignal): unknown {
  return signal.aborted ? error : new NotTaken(undefined);
}

// One call, answer read in full, under a time limit that covers the body too.
// A vendor that does not answer in time is `NotTaken` with no status, which is
// the same transient failure as a dropped connection.
async function call(
  env: VendorEnv,
  signal: AbortSignal,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(address(env.EXAMPLE_URL, path), {
      method,
      headers: {
        Authorization: `Bearer ${env.EXAMPLE_TOKEN}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(timeoutOf(env.EXAMPLE_TIMEOUT_MS)),
      ]),
    });
  } catch (error) {
    throw unanswered(error, signal);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `the example vendor refused the token: ${String(response.status)}`,
    );
  }
  if (!response.ok) throw new NotTaken(response.status);
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw unanswered(error, signal);
  }
  return text === "" ? undefined : (JSON.parse(text) as unknown);
}

async function itemOf(
  env: VendorEnv,
  signal: AbortSignal,
  id: string,
): Promise<VendorItem | undefined> {
  try {
    return (await call(
      env,
      signal,
      "GET",
      `items/${encodeURIComponent(id)}`,
    )) as VendorItem;
  } catch (error) {
    if (error instanceof NotTaken && error.status === 404) return undefined;
    throw error;
  }
}

// Replace the type file, the environment, `run` and `onChange` with your
// vendor's. A connector that only reads leaves out `onChange` and the type's
// `link_field`.
const connector = defineConnector({
  name: "example",
  description:
    "Items from the example vendor's list, and changes to them carried back.",
  source: "example",
  types: [
    {
      // Imported JSON widens every string, so its field types read as
      // `string` here; the check on start holds the file to the server's.
      type: exampleItem as TypeDefinition,
      fields: ["example_id", "title", "url", "note"],
    },
  ],
  env: {
    EXAMPLE_URL: "required",
    EXAMPLE_TOKEN: "secret",
    EXAMPLE_TIMEOUT_MS: "optional",
  },
  // Refuses on start what can be told wrong on sight, naming the variable and
  // never its value.
  checkEnv(env) {
    checkAddress(env.EXAMPLE_URL);
    timeoutOf(env.EXAMPLE_TIMEOUT_MS);
  },
  async run({ env, signal, log, upsert, archive, held }) {
    const { account, items } = (await call(env, signal, "GET", "items")) as {
      account: string;
      items: VendorItem[];
    };
    // The account inside the source id, so two accounts under one source
    // never share a row.
    const key = (item: VendorItem): string => `${account}:${item.id}`;

    const untitled = items.filter(
      (item) => item.deleted !== true && item.title === undefined,
    );
    if (untitled.length > 0) {
      log.condition(
        "untitled",
        untitled.length === 1
          ? "an item has no title and is left out"
          : `${String(untitled.length)} items have no title and are left out`,
      );
    }
    // Every entry carries the link: the kit refuses one without it.
    const entries: Entry[] = items
      .filter((item) => item.deleted !== true && item.title !== undefined)
      .map((item) => ({
        source_id: key(item),
        properties: {
          example_id: item.id,
          title: item.title,
          url: item.url,
          note: item.note,
        },
        occurred_at: item.created,
        // For the conflict rule.
        changed_at: item.updated,
      }));
    await upsert(exampleItem.id, entries);

    // What to archive: what the vendor marks deleted, and what it no longer
    // lists and says it no longer has. An item the listing leaves out that
    // the vendor still answers for is left as it is.
    const gone = items
      .filter((item) => item.deleted === true)
      .map((item) => item.id);
    const listed = new Set(items.map((item) => item.id));
    // A lookup the vendor fails stops the asking, but what is certain is
    // archived first, so one bad answer does not hold back the rest.
    let failed: Error | undefined;
    for (const row of await held(exampleItem.id)) {
      const id = row.properties["example_id"];
      if (typeof id !== "string" || listed.has(id)) continue;
      try {
        const found = await itemOf(env, signal, id);
        if (found === undefined || found.deleted === true) gone.push(id);
      } catch (error) {
        if (signal.aborted) throw error;
        failed =
          error instanceof Error
            ? error
            : new Error("a lookup failed", { cause: error });
        break;
      }
    }
    // Archive matches the link value when the type has a `link_field`, else
    // the source id: a read-only copy that drops `link_field` must archive by
    // `key(item)`.
    await archive(exampleItem.id, gone);
    if (failed !== undefined) throw failed;
  },
  async onChange(
    { kind, item, changed, attempted, refused },
    { env, signal, setLink },
  ) {
    // The vendor has no state for a row set aside: only what changed
    // beside it travels.
    if (kind === "archived" && changed.size === 0) return;
    const id = item.properties["example_id"];
    const linked = typeof id === "string" && id !== "" ? id : undefined;
    // Null for a property the row does not have, so a value cleared in
    // Marfa is cleared at the vendor rather than left as it was.
    const body = {
      title: item.properties["title"] ?? null,
      url: item.properties["url"] ?? null,
      note: item.properties["note"] ?? null,
    };
    try {
      if (linked === undefined) {
        if (kind === "trashed" || kind === "purged") return;
        // The row's id is the idempotency key, so a run that fails between
        // the vendor's answer and the link makes one item when it retries;
        // a refused create made nothing, so the next takes a key of its own.
        const made = (await call(env, signal, "POST", "items", body, {
          "Idempotency-Key":
            refused === undefined ? item.id : `${item.id}:${refused}`,
        })) as { id: string };
        // Linked first, so whatever follows changes this item, never makes
        // another. A retry may be answered with what the first try made,
        // from the values the row held then, so it is brought up to date.
        await setLink(item, made.id);
        if (attempted !== undefined) {
          await call(
            env,
            signal,
            "PUT",
            `items/${encodeURIComponent(made.id)}`,
            body,
          );
        }
        return;
      }
      const path = `items/${encodeURIComponent(linked)}`;
      if (kind === "trashed" || kind === "purged") {
        // A trash and a purge can reach the connector together, as the
        // purge alone, so the purge must delete too. A 404 is what either
        // asked for.
        await call(env, signal, "DELETE", path).catch((error: unknown) => {
          if (!(error instanceof NotTaken) || error.status !== 404) throw error;
        });
        return;
      }
      await call(env, signal, "PUT", path, {
        ...body,
        ...(kind === "restored" && { deleted: false }),
      });
    } catch (error) {
      throw undelivered(error, signal);
    }
  },
  async remake({ item, attempted, refused }, { env, signal, setLink }) {
    const id = item.properties["example_id"];
    if (typeof id !== "string" || id === "") return false;
    try {
      if ((await itemOf(env, signal, id)) !== undefined) return false;
    } catch (error) {
      throw undelivered(error, signal);
    }
    // Made again and linked, under a key of its own so the vendor does
    // not answer the first create again, nor a refused remake's.
    const body = {
      title: item.properties["title"] ?? null,
      url: item.properties["url"] ?? null,
      note: item.properties["note"] ?? null,
    };
    try {
      const made = (await call(env, signal, "POST", "items", body, {
        "Idempotency-Key": `${item.id}:${id}${refused === undefined ? "" : `:${refused}`}`,
      })) as { id: string };
      await setLink(item, made.id);
      if (attempted !== undefined) {
        await call(
          env,
          signal,
          "PUT",
          `items/${encodeURIComponent(made.id)}`,
          body,
        );
      }
    } catch (error) {
      throw undelivered(error, signal);
    }
    return true;
  },
});

await main(connector);
