import { createParser } from "eventsource-parser";

export interface Frame {
  id: string | undefined;
  event: string;
  data: string;
}

export async function* frames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Frame> {
  const decoder = new TextDecoder();
  const closed: Frame[] = [];
  const parser = createParser({
    onEvent: ({ id, event, data }) => {
      closed.push({ id, event: event ?? "message", data });
    },
  });
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
      yield* closed.splice(0);
    }
    // A frame the stream ended inside is not a frame: only the blank
    // line says the server finished it, and a cut may be mid-value.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
