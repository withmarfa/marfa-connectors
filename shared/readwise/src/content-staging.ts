import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FileSource } from "@withmarfa/connector";

/** Finish vendor reads outside the scoped write and replay bytes for each kit attempt. */
export async function stageContent(
  content: Awaited<ReturnType<FileSource["load"]>>,
  signal: AbortSignal,
): Promise<{ load: FileSource["load"]; dispose(): Promise<void> }> {
  let directory: string;
  try {
    directory = await mkdtemp(join(tmpdir(), "readwise-content-"));
  } catch (error) {
    if (!(content.bytes instanceof Uint8Array))
      await content.bytes.cancel().catch(() => undefined);
    throw error;
  }
  const path = join(directory, "content");
  const readers = new Set<ReadStream>();
  const dispose = async () => {
    await Promise.all(
      [...readers].map(
        (stream) =>
          new Promise<void>((resolve) => {
            if (stream.closed) {
              resolve();
              return;
            }
            stream.once("close", resolve);
            stream.destroy();
          }),
      ),
    );
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const input =
      content.bytes instanceof Uint8Array
        ? Readable.from([content.bytes])
        : Readable.fromWeb(content.bytes);
    await pipeline(
      input,
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    signal.throwIfAborted();
    return {
      load(loadSignal) {
        loadSignal.throwIfAborted();
        const stream = createReadStream(path, { signal: loadSignal });
        readers.add(stream);
        stream.once("close", () => {
          readers.delete(stream);
        });
        return Promise.resolve({
          bytes: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
          mime_type: content.mime_type,
        });
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
