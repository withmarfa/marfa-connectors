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

class Refused extends Error {
  constructor(readonly status: number) {
    super(`the example vendor answered ${String(status)}`);
  }
}

// A refused token throws a plain Error and fails the run; any other refusal
// throws `Refused`, for the caller to handle.
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
        // For the conflict rule.
        changed_at: item.updated,
      }));
    await upsert(exampleItem.id, entries);
    await archive(
      exampleItem.id,
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
        // The row's id is the idempotency key, so a run that fails between
        // the vendor's answer and the link makes one item when it retries.
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
        // A trash and a purge can reach the connector together, as the
        // purge alone, so the purge must delete too. A 404 is what either asked for.
        await call(env, signal, "DELETE", path).catch((error: unknown) => {
          if (!(error instanceof Refused) || error.status !== 404) throw error;
        });
        return;
      }
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
