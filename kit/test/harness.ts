import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineConnector,
  type Change,
  type Entry,
  type TypeDefinition,
} from "../src/define.js";
import { start } from "../src/main.js";
import type { Clock, Runtime } from "../src/runtime.js";
import { ScriptedServer } from "./scripted-server.js";

interface Sleep {
  ms: number;
  wake: () => void;
}

/**
 * A clock whose sleeps end only when a test ends them, so a schedule is
 * stepped through rather than waited out.
 */
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

  /** Resolves once a sleep of `ms` is pending. */
  async sleeping(ms: number): Promise<void> {
    while (!this.pending.some((sleep) => sleep.ms === ms)) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  get waiting(): number {
    return this.pending.length;
  }

  /** Moves the time on without ending any sleep, as a slow run does. */
  advance(ms: number): void {
    this.time += ms;
  }

  /** Ends a pending sleep of `ms`, waiting for one to be pending. */
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
    /** The vendor's own id for the entry, the link of the two-way connector. */
    vendor_id: { type: "string" },
  },
};

/** What the test vendor holds, which a test changes between runs. */
export interface Vendor {
  entries: Entry[];
  archived: string[];
  token: string | undefined;
  /** Awaited inside the run, so a test can hold a run open. */
  gate?: Promise<void> | undefined;
  fail?: Error | undefined;
  conditions?: [string, string][];
  logs?: string[];
  warnings?: string[];
  runs: number;
  /** What the two-way connector was handed to carry back, in order. */
  changes: Change[];
  /** A push that throws, the first time the named row is offered. */
  pushFail?: { id: string; error: Error } | undefined;
  /** The vendor's id for a row the vendor has not been told about. */
  vendorIdFor?: ((change: Change) => string | undefined) | undefined;
}

export function vendor(entries: Entry[] = []): Vendor {
  return { entries, archived: [], token: undefined, runs: 0, changes: [] };
}

export function testConnector(held: Vendor) {
  return defineConnector({
    name: "test",
    description: "A connector the kit's tests drive.",
    source: "test",
    type: testType,
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
      await context.upsert(held.entries);
      if (held.archived.length > 0) await context.archive(held.archived);
    },
  });
}

/**
 * The two-way connector: the same pull as the one-way one, a link on the
 * type's `vendor_id`, and a push that records what it was handed, writes
 * the vendor's id back where the test says one, and throws where the test
 * says so.
 */
export function twoWayConnector(held: Vendor) {
  return defineConnector({
    name: "test",
    description: "A two-way connector the kit's tests drive.",
    source: "test",
    type: testType,
    link: "vendor_id",
    env: { TEST_TOKEN: "secret", TEST_REGION: "optional" },
    async run(context) {
      held.runs += 1;
      if (held.gate !== undefined) await held.gate;
      for (const [key, message] of held.conditions ?? []) {
        context.log.condition(key, message);
      }
      if (held.fail !== undefined) throw held.fail;
      if (held.token !== undefined) context.state.set("token", held.token);
      await context.upsert(held.entries);
      if (held.archived.length > 0) await context.archive(held.archived);
    },
    async onChange(change, context) {
      held.changes.push(change);
      if (held.pushFail?.id === change.item.id) {
        const { error } = held.pushFail;
        held.pushFail = undefined;
        throw error;
      }
      const id = held.vendorIdFor?.(change);
      if (id !== undefined) await context.setLink(change.item, id);
    },
  });
}

export const secretToken = "tok_vendor_secret_value";

export class Harness {
  readonly lines: string[] = [];
  readonly clock = new ManualClock();
  requestTimeoutMs = 5000;
  quietMs = 100;
  private stopListener: (() => void) | undefined;

  constructor(
    readonly server: ScriptedServer,
    readonly stateDir: string,
  ) {}

  static async create(): Promise<Harness> {
    const server = await new ScriptedServer("test").start();
    const dir = await mkdtemp(join(tmpdir(), "connector-kit-"));
    return new Harness(server, dir);
  }

  async close(): Promise<void> {
    await this.server.stop();
    await rm(this.stateDir, { recursive: true, force: true });
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
        MARFA_STATE_DIR: this.stateDir,
        TEST_TOKEN: secretToken,
        ...env,
      },
      write: (line) => this.lines.push(line),
      clock: this.clock,
      requestTimeoutMs: this.requestTimeoutMs,
      quietMs: this.quietMs,
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

  /** One run of the two-way connector. */
  twoWay(
    held: Vendor,
    env?: Record<string, string | undefined>,
  ): Promise<number> {
    return start(twoWayConnector(held), this.runtime(["--once"], env));
  }

  /** The state file kept for a key whose own source is `keySource`. */
  async stateFile(keySource = "test"): Promise<unknown> {
    return JSON.parse(
      await readFile(
        join(this.stateDir, `${encodeURIComponent(keySource)}.json`),
        "utf8",
      ),
    );
  }

  lastRun() {
    const run = this.server.runs.at(-1);
    if (run === undefined) throw new Error("no run was reported");
    return run;
  }
}
