import { describe, expect, it } from "vitest";
import { frames, type Frame } from "../src/sse.js";

function stream(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
      }
      controller.close();
    },
  });
}

async function all(chunks: (string | Uint8Array)[]): Promise<Frame[]> {
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

  it("drops comments, keeps a value without a leading space, and drops a last frame the stream ended inside", async () => {
    expect(await all([": keep-alive\n", "event:ping\ndata:x\n\n"])).toEqual([
      { id: undefined, event: "ping", data: "x" },
    ]);
    expect(await all([": keep-alive\n", "event:ping\ndata:x"])).toEqual([]);
  });

  it("yields nothing for a stream of comments alone", async () => {
    expect(await all([": connected\n\n: still here\n\n"])).toEqual([]);
  });

  it("reads a frame with no event field as a message", async () => {
    expect(await all(["id: 4\ndata: x\n\n"])).toEqual([
      { id: "4", event: "message", data: "x" },
    ]);
  });

  it("ignores one byte order mark at the start of the stream, even split across chunks", async () => {
    const bom = [0xef, 0xbb, 0xbf];
    const text = new TextEncoder().encode("event: a\ndata: 1\n\n");
    const expected = [{ id: undefined, event: "a", data: "1" }];
    expect(await all([new Uint8Array([...bom, ...text])])).toEqual(expected);
    expect(
      await all([
        new Uint8Array(bom.slice(0, 2)),
        new Uint8Array([0xbf, ...text]),
      ]),
    ).toEqual(expected);
  });

  it("reads a field name with no colon as a field with an empty value", async () => {
    expect(await all(["event\ndata\n\n"])).toEqual([
      { id: undefined, event: "message", data: "" },
    ]);
  });

  it("ignores retry lines and fields it does not know", async () => {
    expect(
      await all([
        "retry: 3000\nretry: soon\nmood: calm\nevent: a\ndata: 1\n\n",
      ]),
    ).toEqual([{ id: undefined, event: "a", data: "1" }]);
  });

  it("ignores an id holding a NUL, and keeps the id before it", async () => {
    expect(await all(["id: 1\nid: 2\u00003\ndata: x\n\n"])).toEqual([
      { id: "1", event: "message", data: "x" },
    ]);
  });

  it("carries an id to its own frame only", async () => {
    expect(await all(["id: 1\ndata: a\n\ndata: b\n\n"])).toEqual([
      { id: "1", event: "message", data: "a" },
      { id: undefined, event: "message", data: "b" },
    ]);
  });

  it("reads CR alone and CRLF split between chunks as line ends", async () => {
    expect(await all(["id: 1\revent: a\rdata: x\r\r"])).toEqual([
      { id: "1", event: "a", data: "x" },
    ]);
    expect(await all(["event: a\r", "\ndata: x\r", "\n\r", "\n"])).toEqual([
      { id: undefined, event: "a", data: "x" },
    ]);
  });

  it("reads a character whose bytes are split across chunks", async () => {
    const bytes = new TextEncoder().encode("data: caf\u00e9\n\n");
    expect(await all([bytes.slice(0, 10), bytes.slice(10)])).toEqual([
      { id: undefined, event: "message", data: "caf\u00e9" },
    ]);
  });

  it("drops a frame cut after a whole line, or with no data, and keeps the ones before it", async () => {
    expect(await all(["data: a\n\ndata: b\n"])).toEqual([
      { id: undefined, event: "message", data: "a" },
    ]);
    expect(await all(["event: a\nid: 1\n\n"])).toEqual([]);
  });

  it("releases the stream when the reader stops early", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: a\n\ndata: b\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const frame of frames(body)) {
      expect(frame.data).toBe("a");
      break;
    }
    expect(cancelled).toBe(true);
  });
});
