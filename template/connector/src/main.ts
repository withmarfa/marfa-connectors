import {
  defineConnector,
  LinkTaken,
  main,
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

/** What the example vendor answered a write with, when it did not do it. */
class Refused extends Error {
  constructor(readonly status: number) {
    super(`the example vendor answered ${String(status)}`);
  }
}

/**
 * One call to the example vendor, with the token and the stop signal. A
 * refused token fails the run by throwing; any other refusal is thrown
 * as `Refused`, for the caller to take as it sees fit.
 */
async function call(
  env: { EXAMPLE_URL: string; EXAMPLE_TOKEN: string },
  signal: AbortSignal,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  const response = await fetch(new URL(path, env.EXAMPLE_URL), {
    method,
    headers: {
      Authorization: `Bearer ${env.EXAMPLE_TOKEN}`,
      ...(body !== undefined && { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `the example vendor refused the token: ${String(response.status)}`,
    );
  }
  if (!response.ok) throw new Refused(response.status);
  return response;
}

/**
 * A connector reading a vendor's JSON list of items and carrying changes
 * made in Marfa back to it. Replace the type file, the environment, the
 * body of `run` and, for a connector that writes back, `onChange` with
 * your vendor's; the kit does the rest. Leave `link` and `onChange` out
 * for a connector that only reads.
 */
const connector = defineConnector({
  name: "example",
  description:
    "Items from the example vendor's list, and changes to them carried back.",
  source: "example",
  // Imported JSON widens every string, so its field types read as `string`
  // here; the check on start holds the file to the server's type.
  type: exampleItem as TypeDefinition,
  // What the vendor holds; the rest of a row's properties are Marfa's own.
  fields: ["example_id", "title", "url", "note"],
  // The property holding the vendor's own id. With it, every row of the
  // type is the connector's, whoever created it.
  link: "example_id",
  env: {
    EXAMPLE_URL: "required",
    EXAMPLE_TOKEN: "secret",
  },
  async run({ env, signal, log, upsert, archive }) {
    const response = await call(env, signal, "GET", "items");
    const { account, items } = (await response.json()) as {
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
        // When the vendor last changed it, for the conflict rule.
        changed_at: item.updated,
      }));
    await upsert(entries);
    // By the link: a row is archived by the vendor's id it carries.
    await archive(
      items.filter((item) => item.deleted === true).map((item) => item.id),
    );
  },
  async onChange({ kind, item, changed }, { env, signal, log, setLink }) {
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
        // A row the vendor has not been told about: made there and linked,
        // unless it is already gone. The row's id as the idempotency key,
        // so a run that fails between the vendor's answer and the link
        // makes one item when the create is sent again.
        if (kind === "trashed" || kind === "purged") return;
        const made = (await (
          await call(env, signal, "POST", "items", body, {
            "Idempotency-Key": item.id,
          })
        ).json()) as { id: string };
        await setLink(item, made.id);
        return;
      }
      const path = `items/${encodeURIComponent(linked)}`;
      if (kind === "trashed" || kind === "purged") {
        // A trash deletes the item. A purge sends the same delete, which
        // changes nothing at a vendor that already took it, and deletes
        // the item where a trash and a purge reach the connector together,
        // as the purge alone. An item already gone is what either asked for.
        await call(env, signal, "DELETE", path).catch((error: unknown) => {
          if (!(error instanceof Refused) || error.status !== 404) throw error;
        });
        return;
      }
      // An update, or a restore, which brings a deleted item back.
      await call(env, signal, "PUT", path, {
        ...body,
        ...(kind === "restored" && { deleted: false }),
      });
    } catch (error) {
      // One row the vendor refuses is a condition, and the run goes on;
      // a refused token was thrown past this, and fails the run.
      if (error instanceof LinkTaken || error instanceof Refused) {
        log.condition(`refused:${item.id}`, `${item.id}: ${error.message}`);
        return;
      }
      throw error;
    }
  },
  async remake({ item }, { env, signal, log, setLink }) {
    const id = item.properties["example_id"];
    if (typeof id !== "string" || id === "") return false;
    try {
      await call(env, signal, "GET", `items/${encodeURIComponent(id)}`);
      // The vendor still has it: the restore is carried after the read.
      return false;
    } catch (error) {
      if (!(error instanceof Refused) || error.status !== 404) throw error;
    }
    // Made again and linked, under a key of its own so the vendor does
    // not answer the first create again.
    try {
      const made = (await (
        await call(
          env,
          signal,
          "POST",
          "items",
          {
            title: item.properties["title"] ?? null,
            url: item.properties["url"] ?? null,
            note: item.properties["note"] ?? null,
          },
          { "Idempotency-Key": `${item.id}:${id}` },
        )
      ).json()) as { id: string };
      await setLink(item, made.id);
    } catch (error) {
      if (error instanceof LinkTaken || error instanceof Refused) {
        log.condition(`refused:${item.id}`, `${item.id}: ${error.message}`);
        return true;
      }
      throw error;
    }
    return true;
  },
});

await main(connector);
