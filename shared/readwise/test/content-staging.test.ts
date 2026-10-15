import { mkdtemp, rm, stat } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { stageContent } from "../src/content-staging.js";
import { download, StorageLimitExceeded } from "../src/content.js";

vi.mock("node:fs/promises", { spy: true });
const signal = new AbortController().signal;
async function directory() {
  const created = vi.mocked(mkdtemp).mock.results.at(-1);
  if (created?.type !== "return")
    throw new Error("staging directory was not created");
  return created.value;
}
afterEach(async () => {
  for (const result of vi.mocked(mkdtemp).mock.results)
    if (result.type === "return") {
      const path = await result.value.catch(() => undefined);
      if (path) await rm(path, { recursive: true, force: true });
    }
  vi.clearAllMocks();
});

it("cancels the vendor stream when a private staging directory cannot be created", async () => {
  const failure = new Error("temporary storage is unavailable");
  vi.mocked(mkdtemp).mockRejectedValueOnce(failure);
  const cancel = vi.fn();
  await expect(
    stageContent(
      { bytes: new ReadableStream({ cancel }), mime_type: "application/pdf" },
      signal,
    ),
  ).rejects.toBe(failure);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it("replays a staged download after an earlier reader stops and cleans up open readers", async () => {
  const bytes = new Uint8Array(200_000).fill(42);
  const staged = await stageContent(
    {
      bytes: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      mime_type: "application/pdf",
    },
    signal,
  );
  const path = await directory();
  expect((await stat(path)).mode & 0o777).toBe(0o700);
  const first = await staged.load(signal);
  expect(first.bytes).toBeInstanceOf(ReadableStream);
  if (!(first.bytes instanceof ReadableStream))
    throw new Error("staged load did not stream");
  const reader = first.bytes.getReader();
  expect((await reader.read()).done).toBe(false);
  await reader.cancel();
  const replay = await staged.load(signal);
  expect(replay.mime_type).toBe("application/pdf");
  expect(
    new Uint8Array(await new Response(replay.bytes).arrayBuffer()),
  ).toEqual(bytes);
  await staged.load(signal);
  await staged.dispose();
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("removes a partially staged file when a streamed resource exceeds its bound", async () => {
  const content = await download(
    "https://readwise-assets.s3.amazonaws.com/fixture.pdf",
    signal,
    {
      maxBytes: 512,
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(256));
                controller.enqueue(new Uint8Array(257));
                controller.close();
              },
            }),
          ),
        ),
    },
  );
  await expect(stageContent(content, signal)).rejects.toBeInstanceOf(
    StorageLimitExceeded,
  );
  await expect(stat(await directory())).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("removes a partially staged file on cancellation", async () => {
  const controller = new AbortController();
  let started: () => void = () => undefined;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  let pulls = 0;
  const content = {
    bytes: new ReadableStream<Uint8Array>({
      pull(stream) {
        if (pulls++ === 0) {
          stream.enqueue(new Uint8Array(256));
          return;
        }
        started();
        return new Promise<void>(() => undefined);
      },
    }),
    mime_type: "application/pdf",
  };
  const staging = stageContent(content, controller.signal);
  const rejected = expect(staging).rejects.toMatchObject({
    name: "AbortError",
  });
  await reading;
  controller.abort();
  await rejected;
  await expect(stat(await directory())).rejects.toMatchObject({
    code: "ENOENT",
  });
});
