import { createHmac } from "node:crypto";
import {
  defineConnector,
  type Change,
  type ConnectionDefinition,
  type Entry,
  type Inbound,
  type Target,
  type TypeDefinition,
} from "../src/define.js";
import { start } from "../src/main.js";
import { Unreachable } from "../src/rows.js";
import { verifyHmac } from "../src/verify.js";
import type { Clock, Runtime } from "../src/runtime.js";
import { ScriptedServer } from "./scripted-server.js";

interface Sleep {
  ms: number;
  wake: () => void;
}

export class ManualClock implements Clock {
  readonly requested: number[] = [];
  private readonly pending: Sleep[] = [];
  private readonly waiters: (() => void)[] = [];
  private time = Date.parse("2026-09-25T09:00:00.000Z");

  now(): Date {
    return new Date(this.time);
  }

  sleep(ms: number, signal: AbortSignal): Promise<void> {
    this.requested.push(ms);
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const sleep: Sleep = {
        ms,
        wake: () => {
          const at = this.pending.indexOf(sleep);
          if (at !== -1) this.pending.splice(at, 1);
          signal.removeEventListener("abort", sleep.wake);
          resolve();
        },
      };
      signal.addEventListener("abort", sleep.wake, { once: true });
      this.pending.push(sleep);
      for (const waiter of this.waiters.splice(0)) waiter();
    });
  }

  async sleeping(ms: number): Promise<void> {
    while (!this.pending.some((sleep) => sleep.ms === ms)) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  get waiting(): number {
    return this.pending.length;
  }

  advance(ms: number): void {
    this.time += ms;
  }

  async wake(ms: number): Promise<void> {
    for (;;) {
      await this.sleeping(ms);
      const sleep = this.pending.find((candidate) => candidate.ms === ms);
      // Ended by its own signal between being found and being woken: the
      // one meant is still to come.
      if (sleep === undefined) continue;
      this.time += ms;
      sleep.wake();
      return;
    }
  }
}

export const testType: TypeDefinition = {
  id: "test.entry",
  label: "Entry",
  description: "An entry from the test vendor.",
  fields: {
    title: { type: "string", required: true },
    note: { type: "string" },
    link: { type: "url" },
    vendor_id: { type: "string" },
  },
};

export const linkedType: TypeDefinition = {
  ...testType,
  link_field: "vendor_id",
};

/** Every property the test vendor holds; `toString` is a name
 *  every object answers. */
export const testFields = ["title", "note", "link", "vendor_id", "toString"];

export interface Vendor {
  entries: Entry[];
  archived: string[];
  token: string | undefined;
  gate?: Promise<void> | undefined;
  fail?: Error | undefined;
  conditions?: [string, string][];
  logs?: string[];
  warnings?: string[];
  runs: number;
  changes: Change[];
  answer?: ((change: Change) => Entry | undefined) | undefined;
  duringRemake?: (() => void) | undefined;
  failAfter?: Error | undefined;
  pushFail?: { id: string; error: Error } | undefined;
  remakeFail?: { id: string; error: Error } | undefined;
  unreachable?: Set<string> | undefined;
  unreachableIn?: Map<string, string> | undefined;
  vendorIdFor?: ((change: Change) => string | undefined) | undefined;
  gone?: Map<string, string>;
  remakes?: { change: Change; runsBefore: number }[];
  hints?: (ReadonlySet<string> | undefined)[];
  revive?: boolean;
  connections?: ConnectionDefinition[];
  readOnly?: string[];
  ask?: { connection: string; target: Target } | undefined;
  answers?: string[][];
}

export function vendor(entries: Entry[] = []): Vendor {
  return { entries, archived: [], token: undefined, runs: 0, changes: [] };
}

export function testConnector(held: Vendor) {
  return defineConnector({
    name: "test",
    description: "A connector the kit's tests drive.",
    source: "test",
    types: [{ type: testType, fields: testFields }],
    ...(held.connections !== undefined && { connections: held.connections }),
    env: { TEST_TOKEN: "secret", TEST_REGION: "optional" },
    async run(context) {
      held.runs += 1;
      if (held.gate !== undefined) await held.gate;
      for (const line of held.logs ?? []) context.log.info(line);
      for (const line of held.warnings ?? []) context.log.warn(line);
      for (const [key, message] of held.conditions ?? []) {
        context.log.condition(key, message);
      }
      if (held.fail !== undefined) throw held.fail;
      if (held.token !== undefined) context.state.set("token", held.token);
      await context.upsert(testType.id, held.entries);
      if (held.archived.length > 0) {
        await context.archive(testType.id, held.archived);
      }
    },
  });
}

function twoWayConnector(held: Vendor) {
  return defineConnector({
    name: "test",
    description: "A two-way connector the kit's tests drive.",
    source: "test",
    types: [
      {
        type: linkedType,
        fields: testFields,
        revive: held.revive === true,
        ...(held.readOnly !== undefined && { readOnly: held.readOnly }),
      },
    ],
    ...(held.connections !== undefined && { connections: held.connections }),
    env: { TEST_TOKEN: "secret", TEST_REGION: "optional" },
    async run(context) {
      held.runs += 1;
      if (held.gate !== undefined) await held.gate;
      for (const [key, message] of held.conditions ?? []) {
        context.log.condition(key, message);
      }
      if (held.fail !== undefined) throw held.fail;
      if (held.token !== undefined) context.state.set("token", held.token);
      await context.upsert(testType.id, held.entries);
      if (held.archived.length > 0) {
        await context.archive(testType.id, held.archived);
      }
      if (held.ask !== undefined) {
        const rows = await context.linked(
          testType.id,
          held.ask.connection,
          held.ask.target,
        );
        (held.answers ??= []).push(
          rows.map((row) => String(row.properties["vendor_id"])),
        );
      }
      if (held.failAfter !== undefined) throw held.failAfter;
    },
    async onChange(change, context) {
      held.changes.push(change);
      if (held.unreachable?.has(change.item.id) === true) {
        throw new Unreachable(`${change.item.id} cannot be reached`);
      }
      const scope = held.unreachableIn?.get(change.item.id);
      if (scope !== undefined) {
        throw new Unreachable(`${scope} cannot be reached`, { scope });
      }
      if (held.pushFail?.id === change.item.id) {
        const { error } = held.pushFail;
        held.pushFail = undefined;
        throw error;
      }
      const id = held.vendorIdFor?.(change);
      if (id !== undefined) await context.setLink(change.item, id);
      return held.answer?.(change);
    },
    async remake(change, context) {
      (held.remakes ??= []).push({ change, runsBefore: held.runs });
      if (held.unreachable?.has(change.item.id) === true) {
        throw new Unreachable(`${change.item.id} cannot be reached`);
      }
      if (held.remakeFail?.id === change.item.id) {
        const { error } = held.remakeFail;
        held.remakeFail = undefined;
        throw error;
      }
      const id = held.gone?.get(change.item.id);
      if (id === undefined) return false;
      held.gone?.delete(change.item.id);
      held.duringRemake?.();
      await context.setLink(change.item, id);
      return true;
    },
  });
}

export const hung: AbortSignal[] = [];

/** How the test connectors read deliveries: signed by `X-Signature`,
 *  `X-Throw` throws, `X-Hang` waits, and a non-JSON body throws in hints. */
const testInbound: Inbound<{ TEST_TOKEN: "secret" }> = {
  verify: (delivery, env, signal) => {
    if (delivery.header("x-hang") !== undefined) {
      hung.push(signal);
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          resolve(true);
        });
      });
    }
    if (delivery.header("x-throw") !== undefined) {
      throw new Error(`cannot read ${new TextDecoder().decode(delivery.body)}`);
    }
    return verifyHmac({
      secret: env.TEST_TOKEN,
      body: delivery.body,
      signature: delivery.header("x-signature"),
    });
  },
  hints: (delivery) => {
    const said = JSON.parse(new TextDecoder().decode(delivery.body)) as {
      ids?: string[];
      type?: string;
      everything?: boolean;
    };
    return said.everything === true
      ? "everything"
      : (said.ids ?? []).map((id) => ({ type: said.type ?? testType.id, id }));
  },
};

export function inboundConnector(held: Vendor) {
  const base = testConnector(held);
  return defineConnector({
    ...base,
    async run(context) {
      (held.hints ??= []).push(
        context.hints === undefined
          ? undefined
          : (context.hints.get(testType.id) ?? new Set()),
      );
      await base.run(context);
    },
    inbound: testInbound,
  });
}

function inboundTwoWayConnector(held: Vendor) {
  const base = twoWayConnector(held);
  return defineConnector({
    ...base,
    async run(context) {
      const named =
        context.hints === undefined
          ? undefined
          : (context.hints.get(testType.id) ?? new Set<string>());
      (held.hints ??= []).push(named);
      if (named === undefined) {
        await base.run(context);
        return;
      }
      held.runs += 1;
      await context.upsert(
        testType.id,
        held.entries.filter((entry) =>
          named.has(String(entry.properties["vendor_id"])),
        ),
      );
      if (held.archived.length > 0) {
        await context.archive(testType.id, held.archived);
      }
    },
    inbound: testInbound,
  });
}

export function signed(
  said: { ids?: string[]; type?: string; everything?: boolean },
  secret = secretToken,
): { body: string; headers: [string, string][] } {
  const body = JSON.stringify(said);
  return {
    body,
    headers: [
      ["X-Signature", createHmac("sha256", secret).update(body).digest("hex")],
    ],
  };
}

export const secretToken = "tok_vendor_secret_value";

export class Harness {
  readonly lines: string[] = [];
  readonly clock = new ManualClock();
  requestTimeoutMs = 5000;
  private stopListener: (() => void) | undefined;

  constructor(readonly server: ScriptedServer) {}

  static async create(): Promise<Harness> {
    return new Harness(
      await new ScriptedServer("test", { types: ["test.entry"] }).start(),
    );
  }

  async close(): Promise<void> {
    await this.server.stop();
  }

  runtime(
    argv: readonly string[],
    env: Record<string, string | undefined> = {},
  ): Runtime {
    return {
      argv,
      env: {
        MARFA_URL: this.server.url,
        MARFA_KEY: this.server.key,
        TEST_TOKEN: secretToken,
        ...env,
      },
      write: (line) => this.lines.push(line),
      clock: this.clock,
      requestTimeoutMs: this.requestTimeoutMs,
      onStop: (listener) => {
        this.stopListener = listener;
      },
    };
  }

  stop(): void {
    this.stopListener?.();
  }

  once(
    held: Vendor,
    env?: Record<string, string | undefined>,
  ): Promise<number> {
    return start(testConnector(held), this.runtime(["--once"], env));
  }

  inbound(
    held: Vendor,
    argv: readonly string[] = ["--once"],
    env?: Record<string, string | undefined>,
  ): Promise<number> {
    return start(inboundConnector(held), this.runtime(argv, env));
  }

  inboundTwoWay(held: Vendor, argv: readonly string[]): Promise<number> {
    return start(inboundTwoWayConnector(held), this.runtime(argv));
  }

  twoWayRunning(held: Vendor, argv: readonly string[]): Promise<number> {
    return start(twoWayConnector(held), this.runtime(argv));
  }

  twoWay(
    held: Vendor,
    env?: Record<string, string | undefined>,
  ): Promise<number> {
    return start(twoWayConnector(held), this.runtime(["--once"], env));
  }

  kept(): Record<string, unknown> {
    return this.server.connectorState ?? {};
  }

  agreement(id: string): Record<string, unknown> | undefined {
    return this.server.agreements.get(id)?.record;
  }

  lastRun() {
    const run = this.server.runs.at(-1);
    if (run === undefined) throw new Error("no run was reported");
    return run;
  }
}
