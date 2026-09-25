import { describe, expect, it } from "vitest";
import { frames, type Frame } from "../src/sse.js";

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function all(chunks: string[]): Promise<Frame[]> {
  const read: Frame[] = [];
  for await (const frame of frames(stream(chunks))) read.push(frame);
  return read;
}

describe("the frame reader", () => {
  it("reads a frame split across chunks, and several in one", async () => {
    const read = await all([
      ': connected\n\nevent: stream_cursor\ndata: {"cursor":"3"}\n\nid: 1\nev',
      'ent: item.created\ndata: {"item":1}\n\nid: 2\nevent: item.updated\nda',
      'ta: {"item":2}\n\n',
    ]);
    expect(read).toEqual([
      { id: undefined, event: "stream_cursor", data: '{"cursor":"3"}' },
      { id: "1", event: "item.created", data: '{"item":1}' },
      { id: "2", event: "item.updated", data: '{"item":2}' },
    ]);
  });

  it("joins the lines of a multi-line data field, and reads CRLF line ends", async () => {
    const read = await all([
      'id: 7\r\nevent: item.updated\r\ndata: {\r\ndata: "a": 1\r\ndata: }\r\n\r\n',
    ]);
    expect(read).toEqual([
      { id: "7", event: "item.updated", data: '{\n"a": 1\n}' },
    ]);
  });

  it("drops comments, keeps a value without a leading space, and yields a last frame with no blank line after it", async () => {
    const read = await all([": keep-alive\n", "event:ping\ndata:x"]);
    expect(read).toEqual([{ id: undefined, event: "ping", data: "x" }]);
  });

  it("yields nothing for a stream of comments alone", async () => {
    expect(await all([": connected\n\n: still here\n\n"])).toEqual([]);
  });
});
