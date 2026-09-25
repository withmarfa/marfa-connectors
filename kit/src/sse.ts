/** One server-sent event, as the stream frames it. */
export interface Frame {
  id: string | undefined;
  event: string;
  data: string;
}

/**
 * Frames from a stream of bytes, as the server writes them: fields one per
 * line, a blank line ending a frame, a line starting with a colon a comment,
 * `data` lines joined with newlines. A frame may arrive split across chunks
 * and several may arrive in one, so the text is kept until a blank line
 * closes what it holds.
 */
export async function* frames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Frame> {
  const decoder = new TextDecoder();
  let text = "";
  let id: string | undefined;
  let event = "message";
  let data: string[] = [];
  const closed = (): Frame | undefined => {
    if (event === "message" && data.length === 0) return undefined;
    const frame = { id, event, data: data.join("\n") };
    id = undefined;
    event = "message";
    data = [];
    return frame;
  };
  const field = (line: string): void => {
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    const rest = colon === -1 ? "" : line.slice(colon + 1);
    const value = rest.startsWith(" ") ? rest.slice(1) : rest;
    if (name === "id") id = value;
    else if (name === "event") event = value;
    else if (name === "data") data.push(value);
  };
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      let at = text.indexOf("\n");
      while (at !== -1) {
        const line = text.slice(0, at).replace(/\r$/, "");
        text = text.slice(at + 1);
        at = text.indexOf("\n");
        if (line === "") {
          const frame = closed();
          if (frame !== undefined) yield frame;
          continue;
        }
        field(line);
      }
    }
    // A frame the stream ended inside is not a frame: the blank line is
    // what says the server finished writing it, and a stream cut off
    // mid-frame may have been cut off mid-value.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
