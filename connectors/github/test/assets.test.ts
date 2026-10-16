import { expect, it } from "vitest";
import { assetUrl, openAsset, assetsIn } from "../src/assets.js";

const id = "01234567-89ab-4cde-8123-456789abcdef";
const signed = `https://private-user-images.githubusercontent.com/42/123-${id}.png?jwt=secret`;
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
it("parses signed assets and unsigned uploads without changing the body", () => {
  const html = `<a href="https://github.com/user-attachments/assets/${id}"><img src="${signed}&amp;x=1" alt="Example"></a><img src="${signed}"><a href="https://github.com/user-attachments/files/12/name.txt">Text</a>`;
  expect(assetsIn(html)).toEqual({
    assets: [{ id, url: signed + "&x=1", title: "Example" }],
    unsigned: ["https://github.com/user-attachments/files/12/name.txt"],
  });
});
it.each([
  "http://private-user-images.githubusercontent.com/a",
  "https://private-user-images.githubusercontent.com.evil.test/a",
  "https://user:pass@objects.githubusercontent.com/a",
  "https://objects.githubusercontent.com:444/a",
  "https://127.0.0.1/a",
  "https://github-production-user-asset-.s3.amazonaws.com/a",
])("refuses an unsafe storage address: %s", (url) => {
  expect(() => assetUrl(url)).toThrow();
});
it("follows only allowed redirects with no credential headers", async () => {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher = ((url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: url instanceof Request ? url.url : url.toString(), init });
    return Promise.resolve(
      seen.length === 1
        ? new Response(null, {
            status: 302,
            headers: {
              location: "https://objects.githubusercontent.com/asset.png",
            },
          })
        : new Response(png, { headers: { "content-type": "image/png" } }),
    );
  }) as typeof fetch;
  const result = await openAsset(signed, AbortSignal.timeout(1000), {
    fetch: fetcher,
  });
  expect(result.mime_type).toBe("image/png");
  expect(
    new Uint8Array(await new Response(result.bytes).arrayBuffer()),
  ).toEqual(png);
  expect(seen).toHaveLength(2);
  for (const { init } of seen) {
    expect(init?.headers).toBeUndefined();
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("manual");
    expect(init?.referrerPolicy).toBe("no-referrer");
  }
});
it("never requests a disallowed redirect destination", async () => {
  let calls = 0;
  const fetcher = (() => {
    calls++;
    return Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.test/private" },
      }),
    );
  }) as typeof fetch;
  await expect(
    openAsset(signed, AbortSignal.timeout(1000), { fetch: fetcher }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});
it.each(["declared", "streamed", "incomplete", "empty", "html"])(
  "rejects unsafe or incomplete bytes: %s",
  async (kind) => {
    const body =
      kind === "empty"
        ? new Uint8Array()
        : kind === "html"
          ? new TextEncoder().encode("<html>Access denied</html>")
          : png;
    const headers: Record<string, string> = {
      "content-type": kind === "html" ? "text/html" : "image/png",
    };
    if (kind === "declared") headers["content-length"] = "100";
    if (kind === "incomplete") headers["content-length"] = "10";
    const fetcher = (() =>
      Promise.resolve(new Response(body, { headers }))) as typeof fetch;
    await expect(
      (async () => {
        const result = await openAsset(signed, AbortSignal.timeout(1000), {
          fetch: fetcher,
          maxBytes: kind === "streamed" ? 8 : 50,
        });
        await new Response(result.bytes).arrayBuffer();
      })(),
    ).rejects.toThrow();
  },
);

it("bounds redirect cycles and accepts the verified S3 host pattern", async () => {
  expect(
    assetUrl(
      "https://github-production-user-asset-123-456.s3.amazonaws.com/file",
    ).hostname,
  ).toContain("s3.amazonaws.com");
  let calls = 0;
  const fetcher = (() => {
    calls++;
    return Promise.resolve(
      new Response(null, { status: 302, headers: { location: "/again" } }),
    );
  }) as typeof fetch;
  await expect(
    openAsset(signed, AbortSignal.timeout(1000), { fetch: fetcher }),
  ).rejects.toThrow("redirect limit");
  expect(calls).toBe(5);
});
it("cancels an over-limit response before consuming its bytes", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const fetcher = (() =>
    Promise.resolve(
      new Response(stream, { headers: { "content-length": "100" } }),
    )) as typeof fetch;
  await expect(
    openAsset(signed, AbortSignal.timeout(1000), {
      fetch: fetcher,
      maxBytes: 10,
    }),
  ).rejects.toThrow();
  expect(cancelled).toBe(true);
});
it("contains a late stream failure without exposing a signed address", async () => {
  const large = new Uint8Array(600);
  large.set(png);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(large);
    },
    pull() {
      throw new Error(signed);
    },
  });
  const fetcher = (() =>
    Promise.resolve(
      new Response(stream, { headers: { "content-type": "image/png" } }),
    )) as typeof fetch;
  await expect(
    (async () => {
      const response = await openAsset(signed, AbortSignal.timeout(1000), {
        fetch: fetcher,
      });
      await new Response(response.bytes).arrayBuffer();
    })(),
  ).rejects.toThrow(/GitHub asset/);
});
it("bounds a stalled download and contains its transport error", async () => {
  const fetcher = ((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          reject(new Error(signed));
        },
        {
          once: true,
        },
      );
    })) as typeof fetch;
  await expect(
    openAsset(signed, AbortSignal.timeout(1000), {
      fetch: fetcher,
      timeoutMs: 5,
    }),
  ).rejects.toThrow("GitHub asset download failed");
});
