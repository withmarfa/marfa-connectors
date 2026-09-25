import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { MarfaClient } from "@withmarfa/client";
import { check } from "./check.js";
import {
  ConnectorUnderProof,
  derivedFrom,
  fieldsOf,
  registeredAsKindOf,
  typeHeld,
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
  section_id: string | null;
  parent_id: string | null;
  labels: string[];
  priority: number;
  due: Record<string, unknown> | null;
  child_order: number;
  checked: boolean;
  completed_at: string | null;
  is_deleted: boolean;
  note_count: number;
  added_at: string;
}

const account = "1001";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    content: `Task ${id}`,
    description: "",
    project_id: "inbox",
    section_id: null,
    parent_id: null,
    labels: [],
    priority: 1,
    due: null,
    child_order: 1,
    checked: false,
    completed_at: null,
    is_deleted: false,
    note_count: 0,
    added_at: "2026-09-20T09:00:00.000000Z",
    ...overrides,
  };
}

/**
 * A person's core.task from a Todoist row. The row is a kind of core task
 * and carries the core's values already, so promoting maps nothing.
 */
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
      section_id: "s1",
      labels: ["Food", "Errands"],
      child_order: 2,
      note_count: 3,
    });
    const b = task("b", {
      content: "Write the note",
      description: "With the details",
      parent_id: "a",
    });
    const c = task("c", { content: "Call back" });
    const d = task("d", {
      content: "Post the letter",
      checked: true,
      completed_at: "2026-09-21T10:00:00.000000Z",
    });
    const e = task("e", { content: "Book the room" });
    const all = [a, b, c, d, e];
    todoist.next(all);
    await check(
      "todoist: a first run registers todoist.task as a kind of core.task and writes the account's tasks at the feed tier",
      async () => {
        const wasHeld = await typeHeld(marfa, "todoist.task");
        await runOnce();
        const written = await rows();
        const tiers = [...new Set([...written.values()].map((r) => r.tier))];
        if (written.size !== all.length || tiers.join() !== "feed") {
          throw new Error(
            `${String(written.size)} rows at ${tiers.join(", ")}`,
          );
        }
        const { own, inherited } = await registeredAsKindOf(
          marfa,
          "todoist.task",
          "core.task",
          wasHeld,
          written.values(),
        );
        const expected =
          "child_order,comment_count,labels,parent_id,project_id,section_id";
        if (own.join() !== expected) {
          throw new Error(`own fields ${own.join(", ")}`);
        }
        const first = written.get(`${account}:a`)?.properties ?? {};
        const done = written.get(`${account}:d`)?.properties ?? {};
        const sub = written.get(`${account}:b`)?.properties ?? {};
        const landed = {
          priority: first["priority"],
          due_at: first["due_at"],
          precision: first["precision"],
          section_id: first["section_id"],
          labels: first["labels"],
          child_order: first["child_order"],
          comment_count: first["comment_count"],
          parent_id: sub["parent_id"],
          status: done["status"],
          completed_at: done["completed_at"],
        };
        const wanted = {
          priority: "urgent",
          due_at: "2026-09-29T23:00:00.000Z",
          precision: "day",
          section_id: "s1",
          labels: ["Food", "Errands"],
          child_order: 2,
          comment_count: 3,
          parent_id: "a",
          status: "completed",
          completed_at: "2026-09-21T10:00:00.000Z",
        };
        if (JSON.stringify(landed) !== JSON.stringify(wanted)) {
          throw new Error(`the server holds ${JSON.stringify(landed)}`);
        }
        return `todoist.task, absent before the run, registered with parent core.task, all ${String(inherited)} of its fields and ${own.join(", ")} beside them; ${String(written.size)} rows, tier feed, every property a field of the type; on the server ${JSON.stringify(landed)}`;
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
        todoist.next(all);
        await runOnce();
        const changed = moved(before, await rows());
        const { summary } = await lastRun(marfa, key.id);
        if (
          changed.length > 0 ||
          !summary?.includes(`unchanged ${String(all.length)}`)
        ) {
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
      "todoist: a task deleted upstream is archived, and nothing else moves",
      async () => {
        const before = await rows();
        todoist.next([{ ...e, is_deleted: true }]);
        await runOnce();
        const after = await rows();
        const changed = moved(before, after);
        const archived = after.get(`${account}:e`);
        if (
          archived?.state !== "archived" ||
          changed.length !== 1 ||
          !changed[0]?.startsWith(`${account}:e `)
        ) {
          throw new Error(
            `e is ${String(archived?.state)}; moved ${changed.join(", ") || "nothing"}`,
          );
        }
        return `e ${String(before.get(`${account}:e`)?.state)} → ${archived.state}; moved ${changed.join(", ")}`;
      },
    );

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
