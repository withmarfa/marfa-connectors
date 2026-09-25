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
    reporters: ["default", new NoSkippedTests()],
  },
});
