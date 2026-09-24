import { defineConnector, main, type Entry } from "@withmarfa/connector";

interface VendorItem {
  id: string;
  title?: string;
  url?: string;
  note?: string;
  created: string;
  deleted?: boolean;
}

/**
 * A connector reading a vendor's JSON list of items. Replace the type, the
 * environment and the body of `run` with your vendor's; the kit does the
 * rest.
 */
const connector = defineConnector({
  name: "example",
  description: "Items from the example vendor's list.",
  source: "example",
  type: {
    id: "example.item",
    label: "Example Item",
    description: "An item as the example vendor lists it.",
    fields: {
      title: { type: "string", required: true },
      url: { type: "url" },
      note: { type: "string" },
    },
    display_hints: { title_field: "title" },
  },
  env: {
    EXAMPLE_URL: "required",
    EXAMPLE_TOKEN: "secret",
  },
  async run({ env, signal, log, upsert, archive }) {
    const response = await fetch(new URL("items", env.EXAMPLE_URL), {
      headers: { Authorization: `Bearer ${env.EXAMPLE_TOKEN}` },
      signal,
    });
    if (!response.ok) {
      throw new Error(`the example vendor answered ${String(response.status)}`);
    }
    const { account, items } = (await response.json()) as {
      account: string;
      items: VendorItem[];
    };
    // The account inside the source id, so two accounts under one source
    // never share a row.
    const key = (item: VendorItem): string => `${account}:${item.id}`;

    const untitled = items.filter((item) => item.title === undefined);
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
        properties: { title: item.title, url: item.url, note: item.note },
        occurred_at: item.created,
      }));
    await upsert(entries);
    await archive(items.filter((item) => item.deleted === true).map(key));
  },
});

await main(connector);
