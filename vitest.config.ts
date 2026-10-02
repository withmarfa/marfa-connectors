import { defineConfig } from "vitest/config";
import { NoSkippedTests } from "./scripts/no-skipped-tests.js";

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
    // Many tests drive real processes and a throttled GitHub client, which
    // pass in a second or two locally and outlast the 5 s default on a loaded
    // CI runner; a test that truly hangs still fails.
    testTimeout: 30_000,
    reporters: ["default", new NoSkippedTests()],
  },
});
