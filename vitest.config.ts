import { defineConfig } from "vitest/config";
import { NoSkippedTests } from "./scripts/no-skipped-tests.js";
import { RetriedTests } from "./scripts/retried-tests.js";

export default defineConfig({
  test: {
    include: ["**/test/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "vendor/**",
      ".claude/**",
      "_trash/**",
      "_archive/**",
    ],
    // Many tests drive real processes, which pass in a second or two locally
    // and outlast the 5 s default on a loaded CI runner; a test that truly
    // hangs still fails.
    testTimeout: 30_000,
    // A failing test runs once more in CI, and RetriedTests reports each one
    // that then passed. Locally a failure stays a failure.
    retry: process.env["CI"] === undefined ? 0 : 1,
    reporters: ["default", new NoSkippedTests(), new RetriedTests()],
  },
});
