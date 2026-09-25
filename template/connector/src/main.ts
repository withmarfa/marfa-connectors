import {
  defineConnector,
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

/** One call to the example vendor, with the token and the stop signal. */
async function call(
  env: { EXAMPLE_URL: string; EXAMPLE_TOKEN: string },
  signal: AbortSignal,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  const response = await fetch(new URL(path, env.EXAMPLE_URL), {
    method,
    headers: {
      Authorization: `Bearer ${env.EXAMPLE_TOKEN}`,
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`the example vendor answered ${String(response.status)}`);
  }
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
  async onChange({ kind, item }, { env, signal, setLink }) {
    // The vendor has no state for a row set aside; a trash and a purge
    // delete its item.
    if (kind === "archived") return;
    const id = item.properties["example_id"];
    const body = {
      title: item.properties["title"],
      url: item.properties["url"],
      note: item.properties["note"],
    };
    if (typeof id !== "string") {
      // A row the vendor has not been told about: made there and linked,
      // unless it is already gone.
      if (kind === "trashed" || kind === "purged") return;
      const made = (await (
        await call(env, signal, "POST", "items", body)
      ).json()) as { id: string };
      await setLink(item, made.id);
      return;
    }
    if (kind === "trashed" || kind === "purged") {
      await call(env, signal, "DELETE", `items/${encodeURIComponent(id)}`);
      return;
    }
    await call(env, signal, "PUT", `items/${encodeURIComponent(id)}`, body);
  },
});

await main(connector);
