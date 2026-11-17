import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Item, TypeDefinition } from "./define.js";
import {
  Refusal,
  type Marfa,
  type RowBatchResult,
  type TableRowOperation,
} from "./marfa.js";

export type TableValues = Readonly<Record<string, unknown>>;

/** A row of a vendor's own table, named by the vendor's key for it. */
export interface TableRow {
  /** Unique within the item's table. The row's id in Marfa is made from it, so
   *  the same key is always the same row, in every run and on every machine. */
  readonly key: string;
  readonly values: TableValues;
}

/** A row the server refused, and why. */
export interface RefusedRow {
  /** The row's key, or its id where the key is unknown, as for a row deleted
   *  because the vendor no longer holds it. */
  readonly key: string;
  readonly column?: string | undefined;
  readonly reason: string;
}

/** Why nothing was written, where the item or the table could not take rows. */
export type Skipped =
  /** No item of the type holds the key. */
  | "missing"
  /** The item is in the bin, whose rows are left alone. */
  | "bin"
  /** The item was purged while the rows were written. */
  | "gone"
  /** The server's type lacks the table and the key may not add it. */
  | "narrowed";

export interface TableReport {
  readonly created: number;
  readonly replaced: number;
  readonly patched: number;
  readonly unchanged: number;
  readonly deleted: number;
  readonly absent: number;
  /** Rows the server refused: the rest of their batch was written. */
  readonly refused: readonly RefusedRow[];
  readonly skipped: Skipped | undefined;
}

/** A row as the server holds it. */
export interface TableRowRead {
  readonly id: string;
  readonly values: TableValues;
  readonly updated_at: string;
}

/** The operations of a call, each named for the report. */
interface Operation {
  readonly op: TableRowOperation;
  readonly label: string;
}

/** The server takes at most 1000 operations in a batch. */
const pageOperations = 500;

/** A page is cut well short of the largest body the server takes, which one
 *  instance may set lower; a refusal as too large halves the page. */
const pageBytes = 512 * 1024;

/** The codes of a refusal that names one operation of a batch. */
const rowRefusals = new Set(["validation_error", "forbidden", "row_not_found"]);

const outcomes = [
  "created",
  "replaced",
  "patched",
  "unchanged",
  "deleted",
  "absent",
] as const;

/**
 * The id the row with this key has in this table of this item: a lowercase
 * UUIDv7 made from the three, so a run sent again, or by another process,
 * writes the same row and never a second. The time part is fixed: an id is
 * only a name here.
 */
export function rowId(item: string, table: string, key: string): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify([item, table, key]))
    .digest()
    .subarray(0, 16);
  bytes[0] = 0x01;
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Fits a row's values to what the server holds: a column with no value is
 *  left out, since a row holds no `null`. */
function held(values: TableValues): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([, value]) => value !== null && value !== undefined,
    ),
  );
}

function sent(op: TableRowOperation): number {
  return Buffer.byteLength(JSON.stringify(op));
}

function pagesOf(operations: readonly Operation[]): Operation[][] {
  const pages: Operation[][] = [];
  let page: Operation[] = [];
  let bytes = 0;
  for (const one of operations) {
    const size = sent(one.op);
    if (
      page.length > 0 &&
      (page.length >= pageOperations || bytes + size > pageBytes)
    ) {
      pages.push(page);
      page = [];
      bytes = 0;
    }
    page.push(one);
    bytes += size;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

/** The key a batch is sent under. The server replays a key it knows for 30
 *  days, so the key is never made from the batch alone: a value that returned
 *  to an earlier state would be replayed and never written. The call's own
 *  random value keeps a retry within the call on one key, and a later call or
 *  run on a fresh one. */
function keyOf(
  call: string,
  item: string,
  table: string,
  page: readonly Operation[],
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([call, item, table, page.map((one) => one.op)]))
    .digest("hex");
  return `rows-${digest.slice(0, 48)}`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The operation a refusal names, where it names one a batch holds. */
function indexOf(error: Refusal, size: number): number | undefined {
  if (
    error.status === undefined ||
    ![400, 403, 404].includes(error.status) ||
    !rowRefusals.has(error.code)
  )
    return undefined;
  const at = error.details["operation"];
  return typeof at === "number" && Number.isInteger(at) && at >= 0 && at < size
    ? at
    : undefined;
}

/** The column a refusal names, and what it says of it. */
function columnOf(error: Refusal): { column?: string; reason: string } {
  const first = record(
    Array.isArray(error.details["errors"]) ? error.details["errors"][0] : {},
  );
  const path = typeof first["path"] === "string" ? first["path"] : "";
  const marker = path.indexOf(".values.");
  const named =
    typeof error.details["column"] === "string"
      ? error.details["column"]
      : marker === -1
        ? undefined
        : path.slice(marker + ".values.".length).split(".")[0];
  const message =
    typeof first["message"] === "string" ? first["message"] : error.detail;
  return { ...(named !== undefined && { column: named }), reason: message };
}

export interface TablesHost {
  readonly marfa: Marfa;
  /** The type as the connector declares it. */
  readonly declared: (type: string) => TypeDefinition | undefined;
  /** Whether the server's type lacks the table and the key may not add it. */
  readonly narrowed: (type: string, table: string) => boolean;
  /** The item the key names, from the instance. */
  readonly find: (type: string, key: string) => Promise<Item | undefined>;
  /** Throws once the run may not write any more. */
  readonly check: () => void;
  /** Raises a condition, which the run's report carries. */
  readonly condition: (key: string, message: string) => void;
}

interface Target {
  /** Made once for each call that writes, for the keys of its batches. */
  readonly call: string;
  readonly id: string;
  readonly type: string;
  readonly key: string;
  readonly table: string;
}

/**
 * The rows of an item's tables. A page the server refuses part-way is not
 * lost: the server writes a batch whole or not at all, so the refused row is
 * left out and reported, and the rest sent again.
 */
export class Tables {
  /** What the server refused this run, by type and table. */
  private readonly refusals = new Map<
    string,
    { count: number; items: Set<string>; first: string[] }
  >();

  constructor(private readonly host: TablesHost) {}

  async put(
    type: string,
    key: string,
    table: string,
    rows: readonly TableRow[],
  ): Promise<TableReport> {
    return this.write(type, key, table, (target) =>
      this.unique(rows).map((row) => ({
        label: row.key,
        op: {
          op: "put",
          id: rowId(target.id, table, row.key),
          values: { ...row.values },
        },
      })),
    );
  }

  async patch(
    type: string,
    key: string,
    table: string,
    rows: readonly TableRow[],
  ): Promise<TableReport> {
    return this.write(type, key, table, (target) =>
      this.unique(rows).map((row) => ({
        label: row.key,
        op: {
          op: "patch",
          id: rowId(target.id, table, row.key),
          values: { ...row.values },
        },
      })),
    );
  }

  async remove(
    type: string,
    key: string,
    table: string,
    rowKeys: readonly string[],
  ): Promise<TableReport> {
    return this.write(type, key, table, (target) =>
      [...new Set(rowKeys)].map((rowKey) => ({
        label: rowKey,
        op: { op: "delete", id: rowId(target.id, table, rowKey) },
      })),
    );
  }

  /**
   * Makes the table hold these rows and no others: it reads what the table
   * holds, writes the rows that are new or differ, and deletes the rest, so a
   * row the vendor removed is removed, and a row unchanged is not written.
   */
  async replace(
    type: string,
    key: string,
    table: string,
    rows: readonly TableRow[],
  ): Promise<TableReport> {
    const wanted = this.unique(rows);
    return this.write(type, key, table, async (target) => {
      this.host.check();
      const existing = new Map(
        (await this.host.marfa.tableRows(target.id, table)).map((row) => [
          row.id,
          row,
        ]),
      );
      const operations: Operation[] = [];
      const kept = new Set<string>();
      let unchanged = 0;
      for (const row of wanted) {
        const id = rowId(target.id, table, row.key);
        kept.add(id);
        const now = existing.get(id);
        if (
          now !== undefined &&
          isDeepStrictEqual(now.values, held(row.values))
        ) {
          unchanged += 1;
          continue;
        }
        operations.push({
          label: row.key,
          op: { op: "put", id, values: { ...row.values } },
        });
      }
      for (const id of existing.keys()) {
        if (!kept.has(id))
          operations.push({ label: id, op: { op: "delete", id } });
      }
      return { operations, unchanged };
    });
  }

  /** The rows of a table as the server holds them, or `undefined` where the
   *  item cannot be read: none holds the key, it is in the bin, or the
   *  server's type lacks the table. */
  async read(
    type: string,
    key: string,
    table: string,
  ): Promise<readonly TableRowRead[] | undefined> {
    this.declaration(type, table);
    if (this.host.narrowed(type, table)) return undefined;
    const item = await this.host.find(type, key);
    if (item === undefined || item.state === "trashed") return undefined;
    this.host.check();
    try {
      const rows = await this.host.marfa.tableRows(item.id, table);
      return rows.map((row) => ({
        id: row.id,
        values: row.values,
        updated_at: row.updated_at,
      }));
    } catch (error) {
      if (error instanceof Refusal && error.code === "item_not_found")
        return undefined;
      throw error;
    }
  }

  private declaration(type: string, table: string): void {
    const tables = this.host.declared(type)?.tables;
    if (tables === undefined || !Object.hasOwn(tables, table))
      throw new Error(`${type} declares no table ${table}`);
  }

  private unique(rows: readonly TableRow[]): TableRow[] {
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.key === "") throw new Error("a table row's key is empty");
      if (seen.has(row.key))
        throw new Error(`the table rows name the key ${row.key} twice`);
      seen.add(row.key);
    }
    return [...rows];
  }

  private async write(
    type: string,
    key: string,
    table: string,
    operations: (
      target: Target,
    ) =>
      | Operation[]
      | { operations: Operation[]; unchanged: number }
      | Promise<Operation[] | { operations: Operation[]; unchanged: number }>,
  ): Promise<TableReport> {
    this.declaration(type, table);
    const report = {
      created: 0,
      replaced: 0,
      patched: 0,
      unchanged: 0,
      deleted: 0,
      absent: 0,
    };
    const refused: RefusedRow[] = [];
    const done = (skipped?: Skipped): TableReport => ({
      ...report,
      refused,
      skipped,
    });
    if (this.host.narrowed(type, table)) return done("narrowed");
    this.host.check();
    const item = await this.host.find(type, key);
    if (item === undefined) return done("missing");
    if (item.state === "trashed") return done("bin");
    const target: Target = {
      call: randomUUID(),
      id: item.id,
      type,
      key,
      table,
    };
    try {
      const planned = await operations(target);
      const list = Array.isArray(planned) ? planned : planned.operations;
      if (!Array.isArray(planned)) report.unchanged += planned.unchanged;
      for (const page of pagesOf(list)) {
        await this.send(target, page, report, refused);
      }
    } catch (error) {
      if (error instanceof Refusal && error.code === "item_not_found") {
        return done(error.details["trashed"] === true ? "bin" : "gone");
      }
      throw error;
    } finally {
      this.raise(target, refused);
    }
    return done();
  }

  private async send(
    target: Target,
    page: Operation[],
    report: Record<(typeof outcomes)[number], number>,
    refused: RefusedRow[],
  ): Promise<void> {
    let answer: RowBatchResult;
    this.host.check();
    try {
      answer = await this.host.marfa.writeTableRows(
        target.id,
        target.table,
        page.map((one) => one.op),
        keyOf(target.call, target.id, target.table, page),
      );
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      if (error.code === "request_too_large") {
        const [only, ...rest] = page;
        if (only === undefined) return;
        if (rest.length === 0) {
          refused.push({
            key: only.label,
            column: undefined,
            reason: "the row is larger than the server takes in a request",
          });
          return;
        }
        const half = Math.ceil(page.length / 2);
        await this.send(target, page.slice(0, half), report, refused);
        await this.send(target, page.slice(half), report, refused);
        return;
      }
      const at = indexOf(error, page.length);
      if (at === undefined) throw error;
      const one = page[at];
      if (one === undefined) throw error;
      refused.push({ key: one.label, ...columnOf(error) });
      const rest = page.filter((_, index) => index !== at);
      if (rest.length > 0) await this.send(target, rest, report, refused);
      return;
    }
    for (const result of answer.results) {
      if ((outcomes as readonly string[]).includes(result.outcome))
        report[result.outcome] += 1;
    }
  }

  /** Raises the refusals of this table as one condition, which the report
   *  carries until a scheduled run that reaches the table finds none. */
  private raise(target: Target, refused: readonly RefusedRow[]): void {
    if (refused.length === 0) return;
    const id = `${target.type} ${target.table}`;
    const held = this.refusals.get(id) ?? {
      count: 0,
      items: new Set<string>(),
      first: [],
    };
    held.count += refused.length;
    held.items.add(target.key);
    for (const row of refused) {
      if (held.first.length >= 3) break;
      held.first.push(
        `${target.key} row ${row.key}${row.column === undefined ? "" : `, column ${row.column}`}: ${row.reason}`,
      );
    }
    this.refusals.set(id, held);
    const items = held.items.size;
    this.host.condition(
      `table-rows:${target.type}:${target.table}`,
      `the server refused ${String(held.count)} ${held.count === 1 ? "row" : "rows"} of the table ${target.table} of ${String(items)} ${target.type} ${items === 1 ? "item" : "items"} and kept the rest of each batch; the vendor still holds them and the next run sends them again: ${held.first.join("; ")}`,
    );
  }
}
