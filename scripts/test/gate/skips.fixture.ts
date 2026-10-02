import { describe, it } from "vitest";

it.skip("waits", () => undefined);

describe.skip("a skipped suite", () => {
  it("never runs", () => undefined);
});
