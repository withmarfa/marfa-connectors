import { describe, expect, it, vi } from "vitest";
import {
  storageUrl,
  download,
  contentPlan,
  digest,
  enqueueContent,
  StorageEmpty,
} from "../src/content.js";

const allowed =
  "https://readwise-assets.s3.amazonaws.com/private/reader/book.pdf?secret=temporary";
const signal = new AbortController().signal;

describe("Reader content boundaries", () => {
  it.each(["body", "no-body", "declared-zero"])(
    "identifies a completed empty HTTP 200 response: %s",
    async (kind) => {
      await expect(
        download(allowed, signal, {
          fetch: () =>
            Promise.resolve(
              new Response(kind === "no-body" ? null : "", {
                headers:
                  kind === "declared-zero" ? { "content-length": "0" } : {},
              }),
            ),
        }),
      ).rejects.toBeInstanceOf(StorageEmpty);
    },
  );
  it("accepts only the verified HTTPS bucket without user info or an unusual port", () => {
    expect(storageUrl(allowed).hostname).toBe(
      "readwise-assets.s3.amazonaws.com",
    );
    const credentialed = new URL(allowed);
    credentialed.username = "user";
    for (const url of [
      "http://readwise-assets.s3.amazonaws.com/a",
      "https://readwise-assets.s3.amazonaws.com.evil.test/a",
      credentialed.href,
      "https://readwise-assets.s3.amazonaws.com:8443/a",
      "http://127.0.0.1/a",
    ])
      expect(() => storageUrl(url)).toThrow("verified Readwise");
  });
  it("revalidates redirects and never sends credentials to storage", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.test/track" },
      }),
    );
    await expect(download(allowed, signal, { fetch: fetcher })).rejects.toThrow(
      "verified Readwise",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toBeUndefined();
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });
  it("bounds a chunked download and detects a generic PDF from its bytes", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response("%PDF-1.7\nbody", {
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    const file = await download(allowed, signal, { fetch: fetcher });
    expect(file.mime_type).toBe("application/pdf");
    expect(
      Buffer.from(await new Response(file.bytes).arrayBuffer()).toString(),
    ).toBe("%PDF-1.7\nbody");
    const excessive = await download(allowed, signal, {
      maxBytes: 300,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(256));
              controller.enqueue(new Uint8Array(60));
              controller.close();
            },
          }),
        ),
      ),
    });
    await expect(new Response(excessive.bytes).arrayBuffer()).rejects.toThrow(
      "limit",
    );
  });
  it("keeps HTML bytes exact and gives every hosted image its own blob plan", () => {
    const html =
      '<!doctype html>\r\n<img src="https://readwise-assets.s3.amazonaws.com/a.png?token=temporary&amp;a=1"><img srcset="https://readwise-assets.s3.amazonaws.com/b.png 2x, https://third.test/pixel 1x">';
    const plan = contentPlan("account:reader-document:book", {
      id: "book",
      category: "pdf",
      html_content: html,
      raw_source_url: allowed,
    });
    expect(plan.resources.filter((r) => r.kind === "image")).toHaveLength(3);
    expect(
      plan.resources.find((r) => r.reason === "third-party"),
    ).toMatchObject({ status: "deliberately-unkept" });
    const htmlFile = plan.files.find((f) => f.kind === "html");
    expect(htmlFile?.text).toBe(html);
    expect(htmlFile?.key).toContain(digest(html));
    expect(plan.files.filter((f) => f.kind === "image")).toHaveLength(2);
    expect(JSON.stringify(plan.resources)).not.toContain("temporary");
    expect(JSON.stringify(plan.resources)).not.toContain("https:");
  });
  it("deduplicates signed URL rotations by resource path", () => {
    const one = contentPlan("a:reader-document:b", {
      id: "b",
      category: "article",
      html_content:
        '<img src="https://readwise-assets.s3.amazonaws.com/a.png?x=1"><img src="https://readwise-assets.s3.amazonaws.com/a.png?x=2">',
    });
    expect(one.files.filter((file) => file.kind === "image")).toHaveLength(1);
  });
});

describe("Reader durable content queue", () => {
  it("acknowledges the bounded queue before callers can advance a page", async () => {
    let saved: unknown;
    const state = {
      get: () => saved,
      checkpoint: vi.fn((_key: string, value: unknown) => {
        saved = structuredClone(value);
        return Promise.resolve({ committed: true as const });
      }),
    };
    const job = {
      id: "one",
      canonical: "a:reader-document:one",
      type: "readwise.source",
      revision: "2026-01-01",
    };
    expect(await enqueueContent(state, [job], 1)).toBe(true);
    expect(await enqueueContent(state, [job], 1)).toBe(true);
    expect(await enqueueContent(state, [{ ...job, id: "two" }], 1)).toBe(false);
    expect(state.checkpoint).toHaveBeenCalledTimes(2);
  });
  it("does not pretend a lost checkpoint was acknowledged", async () => {
    const state = {
      get: () => undefined,
      checkpoint: () =>
        Promise.resolve({
          committed: false as const,
          reason: "state-oversized" as const,
        }),
    };
    await expect(
      enqueueContent(state, [
        {
          id: "one",
          canonical: "a:reader-document:one",
          type: "readwise.source",
          revision: "now",
        },
      ]),
    ).rejects.toThrow("not acknowledged");
  });
});
