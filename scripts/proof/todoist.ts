import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { MarfaClient } from "@withmarfa/client";
import { check } from "./check.js";
import {
  ConnectorUnderProof,
  derivedFrom,
  fieldsOf,
  item,
  lastRun,
  mintAsReadmeSays,
  moved,
  promoteAndFind,
  registration,
  rowsOf,
  trash,
  type Item,
} from "./connector.js";

interface Task {
  id: string;
  content: string;
  description: string;
  project_id: string;
  priority: number;
  due: Record<string, unknown> | null;
  checked: boolean;
  is_deleted: boolean;
  added_at: string;
}

const account = "1001";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    content: `Task ${id}`,
    description: "",
    project_id: "inbox",
    priority: 1,
    due: null,
    checked: false,
    is_deleted: false,
    added_at: "2026-09-20T09:00:00.000000Z",
    ...overrides,
  };
}

/** A person's core.task from a Todoist row: the fields it inherits, as they stand. */
async function asTask(
  marfa: MarfaClient,
  row: Item,
): Promise<Record<string, unknown>> {
  const { fields } = await fieldsOf(marfa, "core.task");
  return Object.fromEntries(
    fields
      .filter((field) => field in row.properties)
      .map((field) => [field, row.properties[field]]),
  );
}

/** A stub of Todoist's Sync API answering whatever delta the proof sets next. */
async function stubTodoist(): Promise<{
  url: string;
  next: (items: Task[]) => void;
  close: () => Promise<void>;
}> {
  let delta: Task[] = [];
  let answered = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const full = form.get("sync_token") === "*";
      answered += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          sync_token: `token-${String(answered)}`,
          items: delta,
          ...(full && {
            user: { id: account, tz_info: { timezone: "Europe/London" } },
          }),
        }),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    next: (items) => {
      delta = items;
    },
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => {
          done();
        });
      }),
  };
}

export async function proveTodoist(
  marfa: MarfaClient,
  url: string,
): Promise<void> {
  const todoist = await stubTodoist();
  let connector: ConnectorUnderProof | undefined;
  try {
    const key = await mintAsReadmeSays(marfa, {
      label: "todoist",
      source: "todoist",
      typePermission: "todoist.task",
      registersType: true,
    });
    const runner = new ConnectorUnderProof("todoist", url, key.key, {
      TODOIST_API_TOKEN: "todoist-proof-token",
      TODOIST_API_URL: todoist.url,
    });
    connector = runner;
    const runOnce = async (): Promise<void> => {
      const { code, output } = await runner.once();
      if (code !== 0)
        throw new Error(`the run exited ${String(code)}: ${output}`);
    };
    const rows = (): Promise<Map<string, Item>> =>
      rowsOf(marfa, "todoist.task", "todoist");
    const row = async (id: string): Promise<Item> => {
      const found = (await rows()).get(`${account}:${id}`);
      if (found === undefined) throw new Error(`no row for task ${id}`);
      return found;
    };

    const a = task("a", {
      content: "Buy milk",
      priority: 4,
      due: { date: "2026-09-30", is_recurring: false },
    });
    const b = task("b", {
      content: "Write the note",
      description: "With the details",
    });
    const c = task("c", { content: "Call back" });
    todoist.next([a, b, c]);
    await check(
      "todoist: a first run registers todoist.task as a kind of core.task and writes the account's tasks at the feed tier",
      async () => {
        await runOnce();
        const taskType = await fieldsOf(marfa, "todoist.task");
        const core = await fieldsOf(marfa, "core.task");
        const written = await rows();
        const tiers = [...new Set([...written.values()].map((r) => r.tier))];
        if (written.size !== 3 || tiers.join() !== "feed") {
          throw new Error(
            `${String(written.size)} rows at ${tiers.join(", ")}`,
          );
        }
        if (
          taskType.parent !== "core.task" ||
          taskType.compatible_with !== undefined
        ) {
          throw new Error(
            `parent ${String(taskType.parent)}, compatible_with ${JSON.stringify(taskType.compatible_with)}`,
          );
        }
        const own = taskType.fields
          .filter((field) => !core.fields.includes(field))
          .sort();
        const unknown = [...written.values()]
          .flatMap((r) => Object.keys(r.properties))
          .filter((field) => !taskType.fields.includes(field));
        const expected =
          "child_order,comment_count,labels,parent_id,project_id,section_id";
        if (own.join() !== expected || unknown.length > 0) {
          throw new Error(
            `own fields ${own.join(", ")}; written outside the type: ${unknown.join(", ")}`,
          );
        }
        return `todoist.task has parent core.task, inherits its ${String(core.fields.length)} fields and adds ${own.join(", ")}; ${String(written.size)} rows, tier feed, source ids ${[...written.keys()].join(", ")}, every property a field of the type`;
      },
    );

    await check(
      "todoist: the registration shows its heartbeat and its last run",
      async () => {
        const found = await registration(marfa, key.id);
        if (
          found.last_heartbeat_at === null ||
          found.last_run?.outcome !== "succeeded"
        ) {
          throw new Error(
            `heartbeat ${String(found.last_heartbeat_at)}, last run ${String(found.last_run?.outcome)}`,
          );
        }
        return `"${found.name}", source ${found.source}, heartbeat ${found.last_heartbeat_at}, last run ${found.last_run.outcome}: ${String(found.last_run.summary)}`;
      },
    );

    await check(
      "todoist: a second run, handed the same tasks, moves no version",
      async () => {
        const before = await rows();
        todoist.next([a, b, c]);
        await runOnce();
        const changed = moved(before, await rows());
        const { summary } = await lastRun(marfa, key.id);
        if (changed.length > 0 || !summary?.includes("unchanged 3")) {
          throw new Error(
            `moved ${changed.join(", ") || "nothing"}; reported ${String(summary)}`,
          );
        }
        return `${String(before.size)} rows, none moved; reported ${summary}`;
      },
    );

    await check(
      "todoist: a change upstream moves exactly that row, by one version",
      async () => {
        const before = await rows();
        todoist.next([{ ...a, content: "Buy oat milk" }]);
        await runOnce();
        const changed = moved(before, await rows());
        if (changed.join() !== `${account}:a 1→2`)
          throw new Error(`moved ${changed.join(", ") || "nothing"}`);
        return `moved ${changed.join(", ")}`;
      },
    );

    await check("todoist: a field cleared upstream is cleared", async () => {
      const before = await row("b");
      if (before.properties["description"] !== "With the details")
        throw new Error("the description never landed");
      todoist.next([{ ...b, description: "" }]);
      await runOnce();
      const after = await row("b");
      if ("description" in after.properties)
        throw new Error("the description is still there");
      return `description present at version ${String(before.version)}, absent at version ${String(after.version)}`;
    });

    await check(
      "todoist: a trashed row is left alone, where an active one changing with it moves",
      async () => {
        const target = await row("c");
        await trash(marfa, target.id);
        const before = await rows();
        todoist.next([
          { ...c, content: "Call back, changed" },
          { ...a, content: "Buy oat milk and bread" },
        ]);
        await runOnce();
        const after = await rows();
        const trashed = after.get(`${account}:c`);
        const changed = moved(before, after);
        if (
          trashed?.state !== "trashed" ||
          trashed.version !== target.version ||
          changed.length !== 1 ||
          !changed[0]?.startsWith(`${account}:a `)
        ) {
          throw new Error(
            `the trashed row is ${String(trashed?.state)} at version ${String(trashed?.version)}; moved ${changed.join(", ") || "nothing"}`,
          );
        }
        return `c stays trashed at version ${String(target.version)}; moved ${changed.join(", ")}`;
      },
    );

    await check(
      "todoist: a promoted core.task sits in the library with a derived-from edge",
      async () => {
        const source = await row("a");
        const { copy } = await promoteAndFind(
          marfa,
          "core.task",
          await asTask(marfa, source),
          source,
          await row("b"),
        );
        const read = await item(marfa, copy.id);
        if (
          read.tier !== "library" ||
          read.properties["priority"] !== "urgent" ||
          read.properties["due_at"] !== source.properties["due_at"] ||
          read.properties["precision"] !== "day"
        ) {
          throw new Error(
            `tier ${String(read.tier)}, priority ${String(read.properties["priority"])}, due ${String(read.properties["due_at"])} at ${String(read.properties["precision"])}`,
          );
        }
        return `core.task at tier ${read.tier} with ${Object.keys(read.properties).join(", ")}: priority ${read.properties["priority"]} from Todoist's 4, due ${String(read.properties["due_at"])} at day precision, taken from the row with no mapping; the edge filter finds it alone, beside an item with no edge and one derived from another row`;
      },
    );

    await check(
      "todoist: the next run leaves the promoted copy alone",
      async () => {
        const source = await row("a");
        const [copy] = await derivedFrom(marfa, "core.task", source);
        if (copy === undefined) throw new Error("no promoted copy");
        todoist.next([{ ...a, content: "Buy oat milk, bread and eggs" }]);
        await runOnce();
        const again = await item(marfa, copy.id);
        const moving = await row("a");
        if (
          again.version !== copy.version ||
          moving.version === source.version
        ) {
          throw new Error(
            `copy ${String(copy.version)}→${String(again.version)}, source ${String(source.version)}→${String(moving.version)}`,
          );
        }
        return `the feed row moved ${String(source.version)}→${String(moving.version)}; the copy stays at version ${String(copy.version)}`;
      },
    );
  } finally {
    await connector?.dispose();
    await todoist.close();
  }
}
