import { execFileSync } from "node:child_process";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { createServer, request as httpsRequest } from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  fetchPicture,
  maxPictureBytes,
  pictureFetcher,
  pictureUserAgent,
  type PictureRefusal,
} from "../src/pictures.js";

// ---- Pictures: the smallest header each format's reader needs. ----

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u16be = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u16le = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const box = (type: string, ...body: Buffer[]): Buffer => {
  const inner = Buffer.concat(body);
  return Buffer.concat([u32(8 + inner.length), Buffer.from(type), inner]);
};

function png(width: number, height: number): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    u32(13),
    Buffer.from("IHDR"),
    u32(width),
    u32(height),
    Buffer.from([8, 6, 0, 0, 0]),
    Buffer.alloc(4),
    Buffer.alloc(40, 1),
  ]);
}

function jpeg(width: number, height: number): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    // An APP0 segment first, so the reader has to skip one.
    Buffer.from([0xff, 0xe0]),
    u16be(16),
    Buffer.from("JFIF\0"),
    Buffer.alloc(9),
    // A Huffman table is not a frame header either.
    Buffer.from([0xff, 0xc4]),
    u16be(4),
    Buffer.alloc(2),
    Buffer.from([0xff, 0xc0]),
    u16be(17),
    Buffer.from([8]),
    u16be(height),
    u16be(width),
    Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function gif(width: number, height: number): Buffer {
  return Buffer.concat([
    Buffer.from("GIF89a"),
    u16le(width),
    u16le(height),
    Buffer.from([0, 0, 0, 0x3b]),
  ]);
}

function webpLossy(width: number, height: number): Buffer {
  const chunk = Buffer.concat([
    Buffer.from([0x10, 0x02, 0x00]),
    Buffer.from([0x9d, 0x01, 0x2a]),
    u16le(width),
    u16le(height),
    Buffer.alloc(8),
  ]);
  return riff("VP8 ", chunk);
}

function webpLossless(width: number, height: number): Buffer {
  const bits = Buffer.alloc(4);
  bits.writeUInt32LE((width - 1) | ((height - 1) << 14));
  return riff(
    "VP8L",
    Buffer.concat([Buffer.from([0x2f]), bits, Buffer.alloc(8)]),
  );
}

function webpExtended(width: number, height: number): Buffer {
  const size = Buffer.alloc(6);
  size.writeUIntLE(width - 1, 0, 3);
  size.writeUIntLE(height - 1, 3, 3);
  return riff("VP8X", Buffer.concat([Buffer.alloc(4), size, Buffer.alloc(8)]));
}

function riff(chunkType: string, payload: Buffer): Buffer {
  const chunk = Buffer.concat([
    Buffer.from(chunkType),
    Buffer.from(Uint32Array.of(payload.length).buffer),
    payload,
  ]);
  return Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from(Uint32Array.of(chunk.length + 4).buffer),
    Buffer.from("WEBP"),
    chunk,
  ]);
}

/** An AVIF or HEIC file: `ftyp`, then `meta` holding the properties in
 *  `iprp` and `ipco`, one `ispe` for each size given. */
function isobmff(brand: string, sizes: [number, number][]): Buffer {
  const ispe = sizes.map(([width, height]) =>
    box("ispe", Buffer.alloc(4), u32(width), u32(height)),
  );
  return Buffer.concat([
    box(
      "ftyp",
      Buffer.from(brand),
      Buffer.alloc(4),
      Buffer.from("mif1"),
      Buffer.from(brand),
    ),
    box(
      "meta",
      Buffer.alloc(4),
      box("hdlr", Buffer.alloc(24)),
      box("iprp", box("ipco", box("colr", Buffer.alloc(8)), ...ispe)),
    ),
    box("mdat", Buffer.alloc(32, 7)),
  ]);
}

/** Like `isobmff`, with the `ftyp` box given. */
function isobmffWith(ftyp: Buffer, sizes: [number, number][]): Buffer {
  const whole = isobmff("avif", sizes);
  const first = whole.readUInt32BE(0);
  return Buffer.concat([ftyp, whole.subarray(first)]);
}

const formats: [string, string, (w: number, h: number) => Buffer][] = [
  ["PNG", "image/png", png],
  ["JPEG", "image/jpeg", jpeg],
  ["GIF", "image/gif", gif],
  ["lossy WebP", "image/webp", webpLossy],
  ["lossless WebP", "image/webp", webpLossless],
  ["extended WebP", "image/webp", webpExtended],
  ["AVIF", "image/avif", (w, h) => isobmff("avif", [[w, h]])],
  ["animated AVIF", "image/avif", (w, h) => isobmff("avis", [[w, h]])],
  ["HEIC", "image/heic", (w, h) => isobmff("heic", [[w, h]])],
  [
    "HEIC with a thumbnail",
    "image/heic",
    (w, h) =>
      isobmff("heic", [
        [Math.min(w, 8), Math.min(h, 8)],
        [w, h],
      ]),
  ],
];

// ---- A local HTTPS server, with a certificate made for the run. ----

interface Seen {
  method: string | undefined;
  path: string | undefined;
  headers: IncomingHttpHeaders;
}
type Handler = (
  seen: Seen,
  respond: ServerResponse,
  base: string,
) => void | Promise<void>;

const directory = mkdtempSync(join(tmpdir(), "pictures-"));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    join(directory, "key.pem"),
    "-out",
    join(directory, "cert.pem"),
    "-days",
    "2",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost",
  ],
  { stdio: "ignore" },
);
const key = readFileSync(join(directory, "key.pem"));
const cert = readFileSync(join(directory, "cert.pem"));
rmSync(directory, { recursive: true });

let routes: Record<string, Handler> = {};
let seen: Seen[] = [];
let port = 0;
const server = createServer({ key, cert }, (req, res) => {
  const entry = {
    method: req.method,
    path: req.url,
    headers: req.headers,
  };
  seen.push(entry);
  const path = req.url ?? "";
  const route = Object.hasOwn(routes, path) ? routes[path] : undefined;
  if (typeof route !== "function") {
    res.writeHead(404).end();
    return;
  }
  void route(entry, res, `https://localhost:${String(port)}`);
});
const base = (): string => `https://localhost:${String(port)}`;

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, done));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
});
afterEach(() => {
  routes = {};
  seen = [];
});

/** Fetches as a connector would, but trusting the test server's certificate. */
const trusting = pictureFetcher(((url: URL, options: object) =>
  httpsRequest(url, { ...options, ca: cert })) as typeof httpsRequest);
const allowed = { privateHosts: new Set(["localhost"]) };

const serve =
  (body: Buffer, type = "application/octet-stream"): Handler =>
  (_seen, res) => {
    res.writeHead(200, { "Content-Type": type }).end(body);
  };
const redirect =
  (to: string, status = 302): Handler =>
  (_seen, res) => {
    res.writeHead(status, { Location: to }).end();
  };

async function refusal(
  address: string,
  options?: Parameters<typeof trusting>[1],
): Promise<PictureRefusal | "fetched"> {
  const result = await trusting(address, options);
  return result.ok ? "fetched" : result.reason;
}

describe("a picture of each format", () => {
  it.each(formats)(
    "%s is fetched, typed by its bytes and measured",
    async (_name, mime, make) => {
      const bytes = make(64, 48);
      // The server's header names another type, which is not believed.
      routes["/p"] = serve(bytes, "text/plain");
      const result = await trusting(`${base()}/p`, allowed);
      expect(result).toMatchObject({
        ok: true,
        mime_type: mime,
        width: 64,
        height: 48,
        url: `${base()}/p`,
      });
      expect(result.ok && Buffer.from(result.bytes).equals(bytes)).toBe(true);
    },
  );

  it("is typed by its bytes when the header claims SVG", async () => {
    routes["/p"] = serve(png(10, 10), "image/svg+xml");
    expect(await trusting(`${base()}/p`, allowed)).toMatchObject({
      ok: true,
      mime_type: "image/png",
    });
  });
});

describe("the request", () => {
  it("is a GET with the fixed User-Agent and no credentials, cookies or referrer, across a redirect", async () => {
    routes["/start"] = (_seen, res) => {
      res
        .writeHead(302, { Location: "/end", "Set-Cookie": "session=1; Path=/" })
        .end();
    };
    routes["/end"] = serve(png(5, 5));
    expect((await trusting(`${base()}/start#fragment`, allowed)).ok).toBe(true);
    expect(seen.map((one) => [one.method, one.path])).toEqual([
      ["GET", "/start"],
      ["GET", "/end"],
    ]);
    for (const { headers } of seen) {
      expect(headers["user-agent"]).toBe(pictureUserAgent);
      expect(headers.cookie).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
      expect(headers.referer).toBeUndefined();
    }
  });

  it("follows a redirect to the same host, and reports where the picture came from", async () => {
    routes["/start"] = redirect("/end", 301);
    routes["/end"] = serve(gif(3, 3));
    expect(await trusting(`${base()}/start`, allowed)).toMatchObject({
      ok: true,
      url: `${base()}/end`,
    });
  });
});

describe("an address that is refused before any connection", () => {
  it("is not https", async () => {
    routes["/p"] = serve(png(5, 5));
    expect(await refusal(`http://localhost:${String(port)}/p`, allowed)).toBe(
      "not_https",
    );
    expect(await refusal("ftp://example.com/p.png")).toBe("not_https");
    expect(seen).toHaveLength(0);
  });

  it("is not an address, or carries credentials", async () => {
    expect(await refusal("not an address")).toBe("invalid_address");
    expect(await refusal("")).toBe("invalid_address");
    expect(await refusal("https://user:secret@example.com/p.png")).toBe(
      "invalid_address",
    );
    expect(
      await refusal(`https://user@localhost:${String(port)}/p`, allowed),
    ).toBe("invalid_address");
    expect(seen).toHaveLength(0);
  });

  it.each([
    "https://127.0.0.1/p.png",
    "https://127.1/p.png",
    "https://2130706433/p.png",
    "https://[::1]/p.png",
    "https://[::ffff:10.0.0.1]/p.png",
    "https://10.0.0.5/p.png",
    "https://192.168.1.1/p.png",
    "https://169.254.169.254/latest/meta-data",
    "https://0.0.0.0/p.png",
  ])("is the private literal %s", async (address) => {
    expect(await refusal(address)).toBe("private_address");
  });

  it("is a private literal, though the host is allowed by another name", async () => {
    routes["/p"] = serve(png(5, 5));
    expect(await refusal(`https://127.0.0.1:${String(port)}/p`, allowed)).toBe(
      "private_address",
    );
    expect(seen).toHaveLength(0);
  });

  it.each([
    "https://feeds.feedburner.com/~r/site/~4/abc",
    "https://pixel.wp.com/g.gif?v=ext",
    "https://stats.wordpress.com/b.gif",
    "https://ssl.google-analytics.com/__utm.gif",
    "https://ad.doubleclick.net/pixel",
  ])("is the known tracker's %s", async (address) => {
    expect(await refusal(address)).toBe("tracker");
  });

  it.each([
    "https://feeds.feedburner.com:8443/~r/site/~4/abc",
    "https://pixel.wp.com:444/g.gif",
    "https://stats.wp.com./g.gif",
    "https://stats.wordpress.com.:8443/b.gif",
  ])(
    "is the known tracker's %s, though it names a port or a final dot",
    async (address) => {
      expect(await refusal(address)).toBe("tracker");
    },
  );
});

describe("a name that resolves to this machine", () => {
  it("is refused unless the connector names the host, and nothing is sent", async () => {
    routes["/p"] = serve(png(5, 5));
    expect(await refusal(`${base()}/p`)).toBe("private_address");
    expect(await refusal(`${base()}/p`, { privateHosts: new Set() })).toBe(
      "private_address",
    );
    expect(
      await refusal(`${base()}/p`, { privateHosts: new Set(["nas.example"]) }),
    ).toBe("private_address");
    expect(seen).toHaveLength(0);
    // The witness: the same request, once the host is named.
    expect(await refusal(`${base()}/p`, allowed)).toBe("fetched");
    expect(seen).toHaveLength(1);
  });
});

describe("a redirect", () => {
  it("to a private literal is refused, though the first host is allowed", async () => {
    routes["/start"] = redirect(`https://127.0.0.1:${String(port)}/secret`);
    routes["/secret"] = serve(png(5, 5));
    expect(await refusal(`${base()}/start`, allowed)).toBe("private_address");
    expect(seen.map((one) => one.path)).toEqual(["/start"]);
  });

  it("to a private address in brackets or decimal is refused", async () => {
    routes["/a"] = redirect("https://[::1]/p");
    routes["/b"] = redirect("https://10.0.0.1/p");
    expect(await refusal(`${base()}/a`, allowed)).toBe("private_address");
    expect(await refusal(`${base()}/b`, allowed)).toBe("private_address");
  });

  it("to http is refused", async () => {
    routes["/start"] = redirect(`http://localhost:${String(port)}/end`);
    expect(await refusal(`${base()}/start`, allowed)).toBe("not_https");
  });

  it("to an address with credentials is refused", async () => {
    routes["/start"] = redirect(
      `https://user:pass@localhost:${String(port)}/end`,
    );
    expect(await refusal(`${base()}/start`, allowed)).toBe("invalid_address");
  });

  it("to a tracker is refused before the tracker is asked", async () => {
    routes["/start"] = redirect("https://stats.wordpress.com/b.gif");
    expect(await refusal(`${base()}/start`, allowed)).toBe("tracker");
    expect(seen).toHaveLength(1);
  });

  it("is followed four times and refused the fifth", async () => {
    for (let at = 0; at < 4; at += 1) {
      routes[`/r${String(at)}`] = redirect(`/r${String(at + 1)}`);
    }
    routes["/r4"] = serve(png(5, 5));
    expect(await refusal(`${base()}/r0`, allowed)).toBe("fetched");
    expect(seen).toHaveLength(5);
    routes["/r4"] = redirect("/r5");
    seen = [];
    expect(await refusal(`${base()}/r0`, allowed)).toBe("too_many_redirects");
    expect(seen).toHaveLength(5);
  });

  it("without a location is a bad status", async () => {
    routes["/p"] = (_seen, res) => {
      res.writeHead(302).end();
    };
    expect(await refusal(`${base()}/p`, allowed)).toBe("bad_status");
  });
});

describe("bytes that are not a picture", () => {
  it("are refused whatever the header says", async () => {
    routes["/html"] = serve(Buffer.from("<!doctype html><p>hi"), "image/png");
    routes["/text"] = serve(Buffer.from("just words"), "image/jpeg");
    routes["/empty"] = serve(Buffer.alloc(0), "image/png");
    routes["/bmp"] = serve(
      Buffer.concat([Buffer.from("BM"), Buffer.alloc(60)]),
    );
    routes["/tiff"] = serve(
      Buffer.concat([Buffer.from([73, 73, 42, 0]), Buffer.alloc(60)]),
    );
    routes["/pdf"] = serve(Buffer.from("%PDF-1.7 ..."));
    routes["/gzip"] = serve(Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]));
    for (const path of [
      "html",
      "text",
      "empty",
      "bmp",
      "tiff",
      "pdf",
      "gzip",
    ]) {
      expect([path, await refusal(`${base()}/${path}`, allowed)]).toEqual([
        path,
        "not_a_picture",
      ]);
    }
  });

  it("are refused when the file is another ISO base media type, or a picture whose size cannot be read", async () => {
    routes["/mp4"] = serve(isobmff("isom", [[64, 64]]));
    routes["/truncated-png"] = serve(png(64, 64).subarray(0, 18));
    routes["/truncated-jpeg"] = serve(jpeg(64, 64).subarray(0, 12));
    routes["/no-frame"] = serve(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    routes["/no-ispe"] = serve(
      Buffer.concat([
        box("ftyp", Buffer.from("avif"), Buffer.alloc(4), Buffer.from("avif")),
        box("meta", Buffer.alloc(4), box("iprp", box("ipco"))),
      ]),
    );
    routes["/odd-webp"] = serve(riff("ABCD", Buffer.alloc(20)));
    for (const path of [
      "mp4",
      "truncated-png",
      "truncated-jpeg",
      "no-frame",
      "no-ispe",
      "odd-webp",
    ]) {
      expect([path, await refusal(`${base()}/${path}`, allowed)]).toEqual([
        path,
        "not_a_picture",
      ]);
    }
  });

  it.each([
    ["a bare element", '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    [
      "one after an XML declaration and a document type",
      '<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg width="1" height="1"/>',
    ],
    [
      "one after a comment",
      "<!-- made by a tool -->\n<SVG viewBox='0 0 9 9'/>",
    ],
    ["one after a byte order mark", "﻿<svg/>"],
  ])("are an SVG document, %s, served as a PNG", async (_name, text) => {
    routes["/p"] = serve(Buffer.from(text), "image/png");
    expect(await refusal(`${base()}/p`, allowed)).toBe("svg");
  });

  it("are refused for a status other than 200", async () => {
    routes["/gone"] = (_seen, res) => {
      res.writeHead(404, { "Content-Type": "image/png" }).end(png(9, 9));
    };
    routes["/created"] = (_seen, res) => {
      res.writeHead(201).end(png(9, 9));
    };
    expect(await refusal(`${base()}/gone`, allowed)).toBe("bad_status");
    expect(await refusal(`${base()}/created`, allowed)).toBe("bad_status");
    expect(await refusal(`${base()}/missing`, allowed)).toBe("bad_status");
  });

  it("carry the status of the answer that was refused, and only that refusal does", async () => {
    routes["/busy"] = (_seen, res) => {
      res.writeHead(503).end();
    };
    routes["/slow-down"] = (_seen, res) => {
      res.writeHead(429, { "Retry-After": "60" }).end();
    };
    routes["/created"] = (_seen, res) => {
      res.writeHead(201).end(png(9, 9));
    };
    routes["/no-location"] = (_seen, res) => {
      res.writeHead(302).end();
    };
    routes["/svg"] = serve(Buffer.from("<svg/>"), "image/png");
    const statusOf = async (path: string): Promise<unknown> => {
      const result = await trusting(`${base()}${path}`, allowed);
      return result.ok ? "fetched" : (result.status ?? "none");
    };
    expect(await statusOf("/busy")).toBe(503);
    expect(await statusOf("/slow-down")).toBe(429);
    expect(await statusOf("/created")).toBe(201);
    expect(await statusOf("/no-location")).toBe(302);
    expect(await statusOf("/missing")).toBe(404);
    // Another reason has no status to carry.
    expect(await statusOf("/svg")).toBe("none");
  });
});

describe("a picture one pixel wide or high", () => {
  it.each(formats)(
    "%s is refused, and its larger twin is not",
    async (_name, _mime, make) => {
      routes["/1x1"] = serve(make(1, 1));
      routes["/1xn"] = serve(make(1, 40));
      routes["/nx1"] = serve(make(40, 1));
      routes["/2x2"] = serve(make(2, 2));
      expect(await refusal(`${base()}/1x1`, allowed)).toBe("one_pixel");
      expect(await refusal(`${base()}/1xn`, allowed)).toBe("one_pixel");
      expect(await refusal(`${base()}/nx1`, allowed)).toBe("one_pixel");
      expect(await refusal(`${base()}/2x2`, allowed)).toBe("fetched");
    },
  );

  it("is refused when a PNG or a GIF says zero", async () => {
    routes["/png"] = serve(png(0, 20));
    routes["/gif"] = serve(gif(20, 0));
    expect(await refusal(`${base()}/png`, allowed)).toBe("one_pixel");
    expect(await refusal(`${base()}/gif`, allowed)).toBe("one_pixel");
  });
});

describe("a picture that claims too many pixels", () => {
  it("is refused by its header, though its bytes are few", async () => {
    routes["/png"] = serve(png(4294967295, 4294967295));
    routes["/jpeg"] = serve(jpeg(65535, 65535));
    routes["/avif"] = serve(isobmff("avif", [[4294967295, 4294967295]]));
    for (const path of ["png", "jpeg", "avif"]) {
      expect([path, await refusal(`${base()}/${path}`, allowed)]).toEqual([
        path,
        "too_large_dimensions",
      ]);
    }
  });

  it("is fetched at 100 million pixels exactly, and refused one pixel more", async () => {
    routes["/at"] = serve(png(10_000, 10_000));
    routes["/over"] = serve(png(10_000, 10_001));
    expect(await refusal(`${base()}/at`, allowed)).toBe("fetched");
    expect(await refusal(`${base()}/over`, allowed)).toBe(
      "too_large_dimensions",
    );
  });
});

describe("a body built to make the reader work", () => {
  // The unfixed pattern never returns on this body, so any bound separates the two, and a slow runner cannot fail
  // the fixed one. The box tests below assert what was refused, not how long it took.
  const freeBoxes = (count: number): Buffer => {
    const free = Buffer.alloc(count * 8);
    for (let at = 0; at < free.length; at += 8) {
      free.writeUInt32BE(8, at);
      free.write("free", at + 4, "latin1");
    }
    return free;
  };
  const meta = (): Buffer =>
    box(
      "meta",
      Buffer.alloc(4),
      box("iprp", box("ipco", box("ispe", Buffer.alloc(4), u32(64), u32(48)))),
    );
  const ftyp = (): Buffer =>
    box("ftyp", Buffer.from("avif"), Buffer.alloc(4), Buffer.from("avif"));

  it("an SVG test that would backtrack is linear", async () => {
    routes["/p"] = serve(Buffer.from("<!---->".repeat(300) + "x"));
    expect(await refusal(`${base()}/p`, allowed)).toBe("not_a_picture");
  });

  it("an SVG after a long run of comments is still an SVG", async () => {
    routes["/p"] = serve(Buffer.from("<!---->".repeat(100) + "<svg/>"));
    expect(await refusal(`${base()}/p`, allowed)).toBe("svg");
  });

  it("a file whose properties come after thousands of small boxes is refused, not listed", async () => {
    routes["/many"] = serve(Buffer.concat([ftyp(), freeBoxes(5_000), meta()]));
    // The witness: the same file with few boxes ahead of the properties is read.
    routes["/few"] = serve(Buffer.concat([ftyp(), freeBoxes(100), meta()]));
    expect(await refusal(`${base()}/many`, allowed)).toBe("not_a_picture");
    expect(await trusting(`${base()}/few`, allowed)).toMatchObject({
      ok: true,
      width: 64,
      height: 48,
    });
  });

  it("an ftyp box far past 256 bytes is refused without reading its brands", async () => {
    // The brand that makes it an AVIF comes last, after a megabyte of others, so a reader that lists every brand
    // would accept the file.
    const brands = Buffer.concat([
      Buffer.alloc(1024 * 1024, "mif1"),
      Buffer.from("avif"),
    ]);
    routes["/p"] = serve(
      Buffer.concat([
        box("ftyp", Buffer.from("mif1"), Buffer.alloc(4), brands),
        meta(),
      ]),
    );
    expect(await refusal(`${base()}/p`, allowed)).toBe("not_a_picture");
  });

  it("an ftyp box is read to 256 bytes and no further", async () => {
    const withBrandLast = (length: number): Buffer =>
      box(
        "ftyp",
        Buffer.from("mif1"),
        Buffer.alloc(4),
        Buffer.alloc(length - 20, "mif1"),
        Buffer.from("avif"),
      );
    routes["/at"] = serve(isobmffWith(withBrandLast(256), [[64, 48]]));
    routes["/over"] = serve(isobmffWith(withBrandLast(260), [[64, 48]]));
    expect(await refusal(`${base()}/at`, allowed)).toBe("fetched");
    expect(await refusal(`${base()}/over`, allowed)).toBe("not_a_picture");
  });

  it("a property box with thousands of small boxes ahead of the size is not walked", async () => {
    const withProperties = (free: Buffer): Buffer =>
      Buffer.concat([
        ftyp(),
        box(
          "meta",
          Buffer.alloc(4),
          box(
            "iprp",
            box("ipco", free, box("ispe", Buffer.alloc(4), u32(64), u32(48))),
          ),
        ),
      ]);
    routes["/many"] = serve(withProperties(freeBoxes(5_000)));
    // The witness: the same property box with few boxes ahead of the size is read.
    routes["/few"] = serve(withProperties(freeBoxes(100)));
    expect(await refusal(`${base()}/many`, allowed)).toBe("not_a_picture");
    expect(await trusting(`${base()}/few`, allowed)).toMatchObject({
      ok: true,
      width: 64,
      height: 48,
    });
  });
});

describe("a picture that is too large", () => {
  it("is refused by its declared length, without reading the body", async () => {
    routes["/p"] = (_seen, res) => {
      res.writeHead(200, { "Content-Length": String(maxPictureBytes + 1) });
      res.write(png(9, 9));
    };
    expect(await refusal(`${base()}/p`, allowed)).toBe("too_large");
  });

  it("is refused by its streamed length when none is declared", async () => {
    routes["/p"] = (_seen, res) => {
      res.writeHead(200);
      const chunk = Buffer.concat([png(9, 9), Buffer.alloc(1024 * 1024)]);
      let sent = 0;
      const next = (): void => {
        while (sent <= maxPictureBytes) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            res.once("drain", next);
            return;
          }
        }
        res.end();
      };
      res.on("error", () => undefined);
      next();
    };
    expect(await refusal(`${base()}/p`, allowed)).toBe("too_large");
  });

  it("is fetched at the limit exactly, and refused one byte over, by a lower limit", async () => {
    const at = Buffer.concat([
      png(9, 9),
      Buffer.alloc(1000 - png(9, 9).length),
    ]);
    routes["/at"] = serve(at);
    routes["/over"] = serve(Buffer.concat([at, Buffer.alloc(1)]));
    expect(await refusal(`${base()}/at`, { ...allowed, maxBytes: 1000 })).toBe(
      "fetched",
    );
    expect(
      await refusal(`${base()}/over`, { ...allowed, maxBytes: 1000 }),
    ).toBe("too_large");
  });

  it("is not allowed a higher limit than the kit's", async () => {
    routes["/p"] = (_seen, res) => {
      res.writeHead(200, { "Content-Length": String(maxPictureBytes + 1) });
      res.write(png(9, 9));
    };
    expect(
      await refusal(`${base()}/p`, {
        ...allowed,
        maxBytes: maxPictureBytes * 4,
      }),
    ).toBe("too_large");
    await expect(trusting(`${base()}/p`, { maxBytes: 0 })).rejects.toThrow(
      RangeError,
    );
  });
});

describe("a slow server", () => {
  it("that never answers is timed out", async () => {
    routes["/p"] = () => undefined;
    expect(await refusal(`${base()}/p`, { ...allowed, timeoutMs: 300 })).toBe(
      "timed_out",
    );
  });

  it("that stops part way through the body is timed out", async () => {
    routes["/p"] = (_seen, res) => {
      res.writeHead(200, { "Content-Length": "5000" });
      res.write(png(9, 9));
    };
    expect(await refusal(`${base()}/p`, { ...allowed, timeoutMs: 300 })).toBe(
      "timed_out",
    );
  });

  it("that redirects slowly is timed out across the hops, not once for each", async () => {
    for (let at = 0; at < 3; at += 1) {
      routes[`/s${String(at)}`] = (_seen, res) => {
        setTimeout(() => {
          res.writeHead(302, { Location: `/s${String(at + 1)}` }).end();
        }, 150);
      };
    }
    routes["/s3"] = serve(png(5, 5));
    expect(await refusal(`${base()}/s0`, { ...allowed, timeoutMs: 400 })).toBe(
      "timed_out",
    );
  });

  it("is stopped by the caller's signal, which throws its reason", async () => {
    routes["/p"] = () => undefined;
    const stop = new AbortController();
    const pending = trusting(`${base()}/p`, {
      ...allowed,
      signal: stop.signal,
    });
    setTimeout(() => {
      stop.abort(new Error("stopped"));
    }, 100);
    await expect(pending).rejects.toThrow("stopped");
  });
});

describe("a connection that fails", () => {
  it("to a closed port is a failed fetch", async () => {
    expect(
      await refusal("https://localhost:1/p", {
        privateHosts: new Set(["localhost"]),
      }),
    ).toBe("fetch_failed");
  });

  it("to a server whose certificate is not trusted is a failed fetch", async () => {
    routes["/p"] = serve(png(5, 5));
    const result = await fetchPicture(`${base()}/p`, allowed);
    expect(result).toEqual({ ok: false, reason: "fetch_failed" });
  });
});
