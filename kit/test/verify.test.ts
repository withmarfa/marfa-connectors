import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyHmac } from "../src/verify.js";

const encoder = new TextEncoder();

describe("verifyHmac", () => {
  it("accepts GitHub's own example and refuses it altered", () => {
    // The worked example in GitHub's documentation on validating deliveries.
    const secret = "It's a Secret to Everybody";
    const signature =
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    const check = { secret, signature, prefix: "sha256=" };
    expect(
      verifyHmac({ ...check, body: encoder.encode("Hello, World!") }),
    ).toBe(true);
    expect(
      verifyHmac({ ...check, body: encoder.encode("Hello, World?") }),
    ).toBe(false);
    expect(
      verifyHmac({
        ...check,
        secret: "another secret",
        body: encoder.encode("Hello, World!"),
      }),
    ).toBe(false);
  });

  it("reads a base64 digest, as Todoist signs", () => {
    const body = encoder.encode('{"event_name":"item:added"}');
    const signature = createHmac("sha256", "client secret")
      .update(body)
      .digest("base64");
    expect(
      verifyHmac({
        secret: "client secret",
        body,
        signature,
        encoding: "base64",
      }),
    ).toBe(true);
    expect(verifyHmac({ secret: "client secret", body, signature })).toBe(
      false,
    );
  });

  it("refuses a missing header, a wrong prefix and a digest of the wrong length", () => {
    const body = encoder.encode("x");
    const digest = createHmac("sha256", "s").update(body).digest("hex");
    expect(verifyHmac({ secret: "s", body, signature: undefined })).toBe(false);
    expect(
      verifyHmac({ secret: "s", body, signature: digest, prefix: "sha256=" }),
    ).toBe(false);
    expect(verifyHmac({ secret: "s", body, signature: digest.slice(2) })).toBe(
      false,
    );
    expect(verifyHmac({ secret: "s", body, signature: "not hex" })).toBe(false);
    expect(verifyHmac({ secret: "s", body, signature: digest })).toBe(true);
  });

  it("refuses a signature without the prefix, though what follows is the digest", () => {
    const body = encoder.encode("x");
    const digest = createHmac("sha256", "s").update(body).digest("hex");
    const check = { secret: "s", body, prefix: "sha256=" };
    expect(verifyHmac({ ...check, signature: `sha256=${digest}` })).toBe(true);
    expect(verifyHmac({ ...check, signature: `sha999=${digest}` })).toBe(false);
  });

  it("refuses a right digest with anything after it, and an empty secret", () => {
    const body = encoder.encode("x");
    const hex = createHmac("sha256", "s").update(body).digest("hex");
    const base64 = createHmac("sha256", "s").update(body).digest("base64");
    expect(
      verifyHmac({ secret: "s", body, signature: hex.toUpperCase() }),
    ).toBe(true);
    for (const tail of ["zz", "a", " "]) {
      expect(verifyHmac({ secret: "s", body, signature: hex + tail })).toBe(
        false,
      );
      expect(
        verifyHmac({
          secret: "s",
          body,
          signature: base64 + tail,
          encoding: "base64",
        }),
      ).toBe(false);
    }
    const unkeyed = createHmac("sha256", "").update(body).digest("hex");
    expect(verifyHmac({ secret: "", body, signature: unkeyed })).toBe(false);
  });

  it("checks bytes that are not text", () => {
    const body = new Uint8Array([0xff, 0xfe, 0x00, 0xc3, 0x28]);
    const signature = createHmac("sha256", "s").update(body).digest("hex");
    expect(verifyHmac({ secret: "s", body, signature })).toBe(true);
  });
});
