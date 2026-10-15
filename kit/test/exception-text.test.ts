import { describe, expect, it } from "vitest";
import { reportableError, withoutBodies } from "../src/exception-text.js";

const redact = (text: string): string =>
  text.split("secret-value-1").join("[redacted]");

describe("withoutBodies", () => {
  it.each([
    [
      'the vendor refused {"title":"private"} today',
      "the vendor refused [removed] today",
    ],
    ['got [1, 2, {"a": "}"}] back', "got [removed] back"],
    ['escaped {"a": "quote \\" } here"} then', "escaped [removed] then"],
    ['nested {"a": {"b": [1, 2]}} end', "nested [removed] end"],
    ['cut off {"title": "priv', "cut off [removed]"],
    ['[{"a":1}] and {"b":2}', "[removed] and [removed]"],
  ])("removes a JSON body: %s", (text, expected) => {
    expect(withoutBodies(text)).toBe(expected);
  });

  it.each([
    "the vendor answered 503",
    "failed with [redacted] and [ERR_STREAM_PREMATURE_CLOSE]",
    "no body here: [ok] and [a b]",
  ])("keeps ordinary text: %s", (text) => {
    expect(withoutBodies(text)).toBe(text);
  });
});

describe("reportableError", () => {
  it("keeps the type, the redacted message and the stack's frames, and drops the properties", () => {
    class VendorError extends Error {
      override name = "VendorError";
      readonly body = { title: "private" };
    }
    const error = new VendorError("refused secret-value-1");
    const out = reportableError(error, redact);
    expect(out).toBeInstanceOf(Error);
    expect(out.name).toBe("VendorError");
    expect(out.message).toBe("refused [redacted]");
    expect(out.stack?.split("\n")[0]).toBe("VendorError: refused [redacted]");
    expect(out.stack).toMatch(/\n {4}at .*exception-text\.test/);
    expect(Object.keys(out)).not.toContain("body");
    expect(JSON.stringify(out.stack)).not.toContain("secret-value-1");
  });

  it("takes only frame lines from a stack, so a message's later lines carry nothing", () => {
    const error = new Error(
      "first line\nsecond line secret-value-1\n    at not a frame",
    );
    const out = reportableError(error, redact);
    expect(out.message).toBe(
      "first line\nsecond line [redacted]\n    at not a frame",
    );
    const lines = (out.stack ?? "").split("\n").slice(3);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^ {4}at /);
  });

  it("walks the causes to a bound, redacting each, and drops a cause that is no error", () => {
    let chain: Error = new Error("bottom secret-value-1");
    for (let depth = 0; depth < 20; depth += 1) {
      chain = new Error(`level ${String(depth)}`, { cause: chain });
    }
    let out: Error | undefined = reportableError(chain, redact);
    let seen = 0;
    while (out !== undefined) {
      seen += 1;
      out = out.cause as Error | undefined;
    }
    expect(seen).toBeGreaterThan(1);
    expect(seen).toBeLessThan(10);
    const odd = reportableError(
      new Error("outer", { cause: { body: "private" } }),
      redact,
    );
    expect(odd.cause).toBeUndefined();
    const text = reportableError(
      new Error("outer", { cause: "text secret-value-1" }),
      redact,
    );
    expect((text.cause as Error).message).toBe("text [redacted]");
  });

  it("survives a cycle", () => {
    const error = new Error("loop");
    error.cause = error;
    expect(reportableError(error, redact).message).toBe("loop");
  });

  it("turns a value that is no error into one, without reading its properties", () => {
    expect(reportableError("plain secret-value-1", redact).message).toBe(
      "plain [redacted]",
    );
    expect(reportableError({ title: "private" }, redact).message).toBe(
      "[object Object]",
    );
    expect(reportableError(undefined, redact).message).toBe("undefined");
  });

  it("never throws, whatever the error does when read", () => {
    const hostile = new Proxy(new Error("x"), {
      get() {
        throw new Error("no");
      },
      getPrototypeOf: () => Error.prototype,
    });
    expect(() => reportableError(hostile, redact)).not.toThrow();
    expect(reportableError(hostile, redact)).toBeInstanceOf(Error);
    const unprintable = {
      toString: () => {
        throw new Error("no");
      },
    };
    expect(reportableError(unprintable, redact)).toBeInstanceOf(Error);
  });

  it("caps a message that is far longer than a report holds", () => {
    const out = reportableError(new Error("x".repeat(100_000)), redact);
    expect(out.message.length).toBeLessThan(3000);
  });
});
