import { defineConfig } from "vitest/config";
import type { Reporter, TestModule, Vitest } from "vitest/node";

/**
 * Fails the run on a skipped test, which would otherwise pass unseen. A
 * name filter given on the command line skips tests on purpose, so a run
 * given one is not held to this.
 */
class NoSkippedTests implements Reporter {
  private filtered = false;

  onInit(vitest: Vitest): void {
    this.filtered = vitest.config.testNamePattern !== undefined;
  }

  onTestRunEnd(testModules: readonly TestModule[]): void {
    if (this.filtered) return;
    const skipped = testModules.flatMap((module) => [
      ...module.children.allTests("skipped"),
    ]);
    for (const test of skipped) {
      console.error(`skipped: ${test.module.moduleId} > ${test.fullName}`);
    }
    if (skipped.length > 0) process.exitCode = 1;
  }
}

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
