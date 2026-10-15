import { expect, it, vi } from "vitest";
import { defineConnector } from "../../../kit/src/define.js";
import { start } from "../../../kit/src/main.js";
import { Harness } from "../../../kit/test/harness.js";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import { drainContent } from "../src/content-queue.js";
import { contentQueue, digest, enqueueContent } from "../src/content.js";
import { readerFileFields, readerFileType } from "../src/content-types.js";
import { ReaderClient } from "../src/reader-client.js";
import { sourceFields, sourceType } from "../src/types.js";

it("refreshes expired storage outside the kit row write and resumes after its durable wait", async () => {
  const server = await new ScriptedServer("readwise", {
    types: [sourceType.id, readerFileType.id],
    edges: ["attached-to"],
  }).start();
  const harness = new Harness(server);
  const canonical = "sample:reader-document:one";
  const bytes = "%PDF-1.7 retained bytes";
  const requests: string[] = [];
  const storage: string[] = [];
  const realFetch = fetch;
  const retryAt = new Date(harness.clock.now().getTime() + 1000).toISOString();
  let releaseAck: () => void = () => undefined;
  const ack = new Promise<void>((resolve) => {
    releaseAck = resolve;
  });
  let reachedAck: () => void = () => undefined;
  const waitingForAck = new Promise<void>((resolve) => {
    reachedAck = resolve;
  });
  const row = {
    id: "one",
    category: "pdf",
    title: "Retained PDF",
    raw_source_url: "https://readwise-assets.s3.amazonaws.com/old.pdf",
  };
  const fetcher: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://reader.example.com/"))
      return realFetch(input, init);
    requests.push(url);
    if (requests.length === 2)
      return Promise.resolve(
        new Response(null, { status: 429, headers: { "Retry-After": "1" } }),
      );
    return Promise.resolve(
      Response.json({
        count: 1,
        nextPageCursor: null,
        results: [
          {
            ...row,
            ...(requests.length > 2 && {
              raw_source_url:
                "https://readwise-assets.s3.amazonaws.com/fresh.pdf",
            }),
          },
        ],
      }),
    );
  };
  vi.stubGlobal("fetch", fetcher);
  server.beforeAnswer = async (request) => {
    if (
      request.method === "PUT" &&
      request.path.endsWith("/state") &&
      (request.body as { state: Record<string, unknown> }).state[
        "outboundRetryAt"
      ] === retryAt
    ) {
      server.beforeAnswer = undefined;
      reachedAck();
      await ack;
    }
  };
  const connector = defineConnector({
    name: "readwise-content-wait",
    source: "readwise",
    env: {},
    types: [
      { type: sourceType, fields: sourceFields },
      { type: readerFileType, fields: readerFileFields },
    ],
    connections: [
      {
        id: "attached-to",
        cardinality: "many-to-many",
        source_type_constraints: [readerFileType.id],
        target_type_constraints: [sourceType.id],
      },
    ],
    async run(context) {
      await context.upsert(sourceType.id, [
        {
          source_id: canonical,
          properties: {
            canonical_key: canonical,
            account: "sample",
            title: row.title,
          },
        },
      ]);
      const state = context.forScope("content-queue").state;
      await enqueueContent(state, [
        { id: row.id, canonical, type: sourceType.id, revision: "new" },
      ]);
      const client = new ReaderClient(
        "https://reader.example.com/api/v3/",
        "content-refresh",
        context.signal,
        {
          now: () => harness.clock.now().getTime(),
          waitUntil: (until) => context.waitUntil(until),
        },
      );
      await drainContent(context, client, state, {
        fetch: (input) => {
          storage.push(input instanceof Request ? input.url : String(input));
          return Promise.resolve(
            storage.length === 1
              ? new Response(null, { status: 403 })
              : new Response(bytes),
          );
        },
      });
      expect(contentQueue(state)).toEqual([]);
    },
  });
  const running = start(connector, harness.runtime(["--once"]));
  try {
    await Promise.race([
      waitingForAck,
      running.then(() => {
        throw new Error(
          `run ended before durable ACK: ${harness.lines.join("\n")}`,
        );
      }),
    ]);
    expect(requests).toHaveLength(2);
    expect(server.blobs.size).toBe(0);
    expect(harness.clock.requested).not.toContain(1000);
    releaseAck();
    await Promise.race([
      harness.clock.sleeping(1000),
      running.then(() => {
        throw new Error("run ended before vendor wait");
      }),
    ]);
    expect(harness.kept()["outboundRetryAt"]).toBe(retryAt);
    expect(requests).toHaveLength(2);
    await harness.clock.wake(1000);
    expect(await running).toBe(0);
    expect(requests).toHaveLength(3);
    expect(requests[2]).toBe(requests[1]);
    expect(storage).toEqual([
      row.raw_source_url,
      "https://readwise-assets.s3.amazonaws.com/fresh.pdf",
    ]);
    const hash = `sha256:${digest(bytes)}`;
    expect(
      server.row(`${canonical}:content:original`).properties["blob_ref"],
    ).toBe(hash);
    expect(server.blobs.get(hash)?.bytes.toString()).toBe(bytes);
    expect(
      server.row(`${canonical}:content:manifest`).properties["preservation"],
    ).toBe("accounted");
  } finally {
    releaseAck();
    harness.stop();
    await running;
    vi.unstubAllGlobals();
    await harness.close();
  }
});
