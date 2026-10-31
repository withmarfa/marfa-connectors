import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CONTRACT_VERSION,
  createClient,
  type MarfaClient,
} from "@withmarfa/client";
import {
  check,
  Failed,
  interrupt,
  interrupted,
  statementsHeld,
} from "./check.js";
import { witnessTypeAnswers } from "./connector.js";
import { proveAdoption } from "./adoption.js";
import { proveRetryArchive } from "./retry-archive.js";
import { proveInboundRetry } from "./inbound-retry.js";
import { proveWatchCheckpoint, proveOutbound } from "./watch-checkpoint.js";
import { proveCheckpoint } from "./checkpoint.js";
import { proveConnectionEvolution } from "./connection-evolution.js";
import { proveGitHub, proveGitHubCoverage } from "./github.js";
import { proveGitHubRelations } from "./github-relations.js";
import { proveGitHubPullRequests } from "./github-pulls.js";
import { proveInbound } from "./inbound.js";
import { proveParentOf } from "./parent-of.js";
import { proveKeys } from "./keys.js";
import { proveReadwise } from "./readwise.js";
import { proveReadwiseReader } from "./readwise-reader.js";
import { proveRss } from "./rss.js";
import { proveTodoist } from "./todoist.js";
import { proveTracker } from "./tracker.js";
import { ProofServer, type Booted } from "./server.js";
import {
  GROUPS,
  parseShard,
  setupStatements,
  shardOf,
  type Group,
  type GroupName,
} from "./shards.js";

/** What a group is given: a booted server and the ways to reach it. */
interface Context {
  url: string;
  marfa: MarfaClient;
  manager: MarfaClient;
  mintKey: ProofServer["mintKey"];
  updateKey: ProofServer["updateKey"];
}

// A group in `shards.ts` without a runner here, or the reverse, does not
// compile, and `scripts/test/proof-shards.test.ts` refuses a `prove` function
// that no runner calls.
const runners: Record<GroupName, (c: Context) => Promise<void>> = {
  adoption: (c) => proveAdoption(c.url, c.marfa, c.manager, c.mintKey),
  rss: (c) => proveRss(c.marfa, c.url, c.manager),
  readwise: (c) => proveReadwise(c.marfa, c.url),
  todoist: (c) => proveTodoist(c.marfa, c.url, c.manager),
  inbound: (c) => proveInbound(c.marfa, c.url, c.manager),
  keys: (c) => proveKeys(c.marfa, c.url, c.manager, c.updateKey),
  tracker: (c) => proveTracker(c.marfa, c.url, c.manager),
  github: (c) => proveGitHub(c.marfa, c.url, c.manager),
  "github-coverage": (c) => proveGitHubCoverage(c.url, c.manager, c.mintKey),
  "github-relations": (c) => proveGitHubRelations(c.url, c.mintKey),
  "connection-evolution": (c) =>
    proveConnectionEvolution(c.url, c.mintKey, c.updateKey),
  "github-pulls": (c) => proveGitHubPullRequests(c.url, c.mintKey),
  "parent-of": (c) => proveParentOf(c.url, c.mintKey),
  checkpoint: (c) => proveCheckpoint(c.marfa, c.url),
  "watch-checkpoint": (c) => proveWatchCheckpoint(c.marfa, c.url),
  outbound: (c) => proveOutbound(c.marfa, c.url),
  "inbound-retry": (c) => proveInboundRetry(c.url, c.marfa),
  "retry-archive": (c) => proveRetryArchive(c.marfa, c.url),
  "readwise-reader": (c) =>
    proveReadwiseReader(c.marfa, c.url, c.mintKey, c.updateKey),
};

/** `--shard 2/3` runs the second of three shards; no argument runs every group. */
function chosen(): Group[] {
  const at = process.argv.indexOf("--shard");
  if (at === -1) return [...GROUPS];
  const value = process.argv[at + 1];
  if (value === undefined) throw new Error("--shard names no shard");
  const { index, count } = parseShard(value);
  return shardOf(GROUPS, index, count);
}

const servers: ProofServer[] = [];
let booting: Promise<unknown> = Promise.resolve();
let stopping = false;

// Armed before the first boot, and kept armed: a signal during a boot waits
// for it to settle, so the server it started is the one stopped, and a second
// signal while that happens must not end the process with a server up.
const onSignal = (signal: NodeJS.Signals): void => {
  interrupt();
  if (stopping) return;
  stopping = true;
  console.log(`stopping on ${signal}`);
  void booting
    .catch(() => undefined)
    .then(() => Promise.all(servers.map((server) => server.stop())))
    .finally(() => process.exit(1));
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

async function boot(): Promise<{ server: ProofServer; booted: Booted }> {
  const server = new ProofServer();
  servers.push(server);
  const starting = server.boot();
  booting = starting;
  return { server, booted: await starting };
}

function contextOf(server: ProofServer, booted: Booted): Context {
  return {
    url: booted.url,
    marfa: createClient({ baseUrl: booted.url, credential: booted.key }),
    manager: createClient({
      baseUrl: booted.url,
      credential: booted.managementKey,
    }),
    mintKey: (body) => server.mintKey(body),
    updateKey: (id, body) => server.updateKey(id, body),
  };
}

async function runGroups(groups: Group[], context: Context): Promise<void> {
  for (const group of groups) {
    const before = statementsHeld();
    await runners[group.name as GroupName](context);
    const made = statementsHeld() - before;
    if (made !== group.statements) {
      throw new Error(
        `${group.name} made ${String(made)} statements, where the proof expects ${String(group.statements)}; the count is \`statements\` in its entry in scripts/proof/shards.ts, so update it when a statement is added or removed`,
      );
    }
  }
}

try {
  const groups = chosen();
  const shared = groups.filter((group) => group.instance === "shared");
  const reader = groups.filter((group) => group.instance === "reader");
  console.log(`running ${groups.map((group) => group.name).join(", ")}`);
  if (shared.length > 0) {
    const pin = (
      await readFile(
        resolve(import.meta.dirname, "../../monorepo.commit"),
        "utf8",
      )
    ).trim();
    let started: { server: ProofServer; booted: Booted } | undefined;
    await check("the pinned server boots", async () => {
      started = await boot();
      if (started.booted.commit !== pin) {
        throw new Error(
          `the checkout is at ${started.booted.commit}, the pin is ${pin}`,
        );
      }
      return `monorepo ${started.booted.commit}, ${started.booted.url}`;
    });
    if (started === undefined) throw new Error("the boot answered nothing");
    const context = contextOf(started.server, started.booted);

    await check("the server speaks the client's contract", async () => {
      const { data } = await context.marfa.GET("/");
      if (data === undefined) throw new Error("the root was refused");
      if (data.contract !== CONTRACT_VERSION) {
        throw new Error(
          `contract ${String(data.contract)}, client ${String(CONTRACT_VERSION)}`,
        );
      }
      if (!data.features.includes("connectors")) {
        throw new Error(
          `features ${data.features.join(", ")} name no connectors`,
        );
      }
      return `contract ${String(data.contract)}, features include connectors`;
    });

    await check(
      "the server answers a type's parent, its fields and its compatible_with",
      () => witnessTypeAnswers(context.marfa),
    );
    if (statementsHeld() !== setupStatements) {
      throw new Error(
        `the setup made ${String(statementsHeld())} statements, where the proof expects ${String(setupStatements)}`,
      );
    }
    await runGroups(shared, context);
  }
  if (reader.length > 0) {
    const { server, booted } = await boot();
    console.log(`Reader fixture proof server ${booted.commit}`);
    await runGroups(reader, contextOf(server, booted));
  }
  console.log(
    `ok   all ${String(statementsHeld())} statements held in ${String(groups.length)} groups`,
  );
} catch (error) {
  if (!(error instanceof Failed) && !interrupted()) {
    console.log(
      `FAIL the proof: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  process.exitCode = 1;
} finally {
  await Promise.all(servers.map((server) => server.stop()));
}
