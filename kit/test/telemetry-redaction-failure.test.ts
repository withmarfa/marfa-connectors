import { afterEach, beforeEach, expect, it } from "vitest";
import { reporting } from "../src/telemetry-posthog.js";
import { startCollector, type Collector } from "./collector.js";

let collector: Collector;
beforeEach(async () => {
  collector = await startCollector();
});
afterEach(async () => {
  await collector.close();
});

it("drops an event whose properties cannot be redacted", async () => {
  const send = async (refuse: boolean) => {
    const reporter = reporting(
      { host: collector.url, token: "test-project-token" },
      (text) => {
        if (refuse && text === "private-property")
          throw new Error("redaction failed");
        return text.replaceAll("private-property", "[redacted]");
      },
      () => undefined,
    );
    reporter.report(new Error("vendor refused a request"), {
      detail: "private-property",
    });
    await reporter.shutdown();
  };

  await send(false);
  expect(collector.posts).toHaveLength(1);
  expect(collector.posts[0]?.text).toContain("[redacted]");
  expect(collector.posts[0]?.text).not.toContain("private-property");

  collector.posts.length = 0;
  await send(true);
  expect(collector.posts).toHaveLength(0);
});
