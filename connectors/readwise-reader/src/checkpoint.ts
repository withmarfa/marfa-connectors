import { deflateSync, inflateSync } from "node:zlib";

const maxStoredBytes = 512 * 1024;
const maxDecodedBytes = 8 * 1024 * 1024;
const maxCompressedBytes = (maxStoredBytes / 4) * 3;
export interface PackedIdentities {
  encoding: "deflate-base64";
  data: string;
}
export function packIdentities(
  value: unknown,
  label: string,
): PackedIdentities {
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > maxDecodedBytes)
    throw new Error(`Reader ${label} exceed their bounded capacity`);
  const compressed = deflateSync(raw);
  if (compressed.length > maxCompressedBytes)
    throw new Error(`Reader compressed ${label} exceed their bounded capacity`);
  return { encoding: "deflate-base64", data: compressed.toString("base64") };
}
export function unpackIdentities(value: unknown, label: string): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "data,encoding" ||
    !("encoding" in value) ||
    value.encoding !== "deflate-base64" ||
    !("data" in value) ||
    typeof value.data !== "string" ||
    value.data.length > maxStoredBytes ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value.data,
    )
  )
    throw new Error(`Reader compressed ${label} are invalid`);
  const compressed = Buffer.from(value.data, "base64");
  if (compressed.length > maxCompressedBytes)
    throw new Error(`Reader compressed ${label} exceed their bounded capacity`);
  try {
    return JSON.parse(
      inflateSync(compressed, { maxOutputLength: maxDecodedBytes }).toString(
        "utf8",
      ),
    ) as unknown;
  } catch {
    throw new Error(`Reader compressed ${label} are invalid or oversized`);
  }
}
