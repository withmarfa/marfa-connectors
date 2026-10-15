import { contentMaxBytes, endpoint, identity } from "@withmarfa/readwise";
import type { EnvValues } from "@withmarfa/connector";
export const env = {
  READWISE_ACCOUNT: "required",
  READWISE_ACCESS_TOKEN: "secret",
  READWISE_API_URL: "optional",
  READWISE_CONTENT_MAX_BYTES: "optional",
  READWISE_READER_API_URL: "optional",
  READWISE_READER_INCLUDE_FEED: "optional",
  READWISE_READER_INBOUND_ONLY: "optional",
  READWISE_READER_PROPAGATE_PURGE: "optional",
} as const;
export interface ReaderConfig {
  account: string;
  readerBase: string;
  exportBase: string;
  includeFeed: boolean;
  inboundOnly: boolean;
  propagatePurge: boolean;
  contentMaxBytes: number;
}
function flag(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be true or false`);
}
export function parseConfig(values: EnvValues<typeof env>): ReaderConfig {
  identity(values.READWISE_ACCOUNT, "source", 1);
  return {
    account: values.READWISE_ACCOUNT,
    contentMaxBytes: contentMaxBytes(values.READWISE_CONTENT_MAX_BYTES),
    readerBase: endpoint(
      values.READWISE_READER_API_URL ?? "https://readwise.io/api/v3/",
    ),
    exportBase: endpoint(values.READWISE_API_URL),
    includeFeed: flag(
      values.READWISE_READER_INCLUDE_FEED,
      "READWISE_READER_INCLUDE_FEED",
    ),
    inboundOnly: flag(
      values.READWISE_READER_INBOUND_ONLY,
      "READWISE_READER_INBOUND_ONLY",
    ),
    propagatePurge: flag(
      values.READWISE_READER_PROPAGATE_PURGE,
      "READWISE_READER_PROPAGATE_PURGE",
    ),
  };
}
