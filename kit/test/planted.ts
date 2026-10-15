/**
 * Values a test plants in a failing run. They live here, away from the test's
 * source, because PostHog's SDK attaches the source lines around each stack
 * frame to an exception, and a value written beside the line that throws would
 * reach the stub through the source and not through the error.
 */
export const planted = {
  /** The value of a variable the connector declares as a secret. */
  credential: "vendor-credential-aGk3Zm9v",
  /** A secret the connector keeps during the run. */
  minted: "minted-run-token-7Hq2Lw9x",
  /** The collector's API key, sent as an OTLP header. */
  header: "collector-api-key-Q8mTn4Vz",
  /** The PostHog project token. */
  project: "phc_project_token_Zp5Rb2Kd",
  /** The text of an item the run read. */
  content: "Quarterly redundancy plan for the Hartwell account",
  /** What the run asked of the vendor. */
  request: "search for the Hartwell redundancy letter",
};

export const item = {
  source_id: "a:1",
  properties: { title: planted.content },
};

export const requestBody = { query: planted.request, limit: 5 };

/** A secret written into the source beside the line that throws. */
export const sourced = "source-line-secret-Xv82Lm4Q";

export function failFromSource(): never {
  // The key was pasted here once: source-line-secret-Xv82Lm4Q
  throw new Error("the vendor answered 401");
}
