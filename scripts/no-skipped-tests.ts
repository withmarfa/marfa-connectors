import type { Reporter, TestModule, Vitest } from "vitest/node";

/**
 * Fails the run on a skipped or todo test or suite, which would otherwise
 * pass unseen. A name filter given on the command line skips tests on
 * purpose, so a run given one is not held to this.
 */
export class NoSkippedTests implements Reporter {
  private filtered = false;

  onInit(vitest: Vitest): void {
    this.filtered = vitest.config.testNamePattern !== undefined;
  }

  onTestRunEnd(testModules: readonly TestModule[]): void {
    if (this.filtered) return;
    const skipped = testModules.flatMap((module) =>
      [
        ...[...module.children.allSuites()].filter(
          (suite) => suite.state() === "skipped",
        ),
        ...module.children.allTests("skipped"),
      ].map((entry) => `${module.moduleId} > ${entry.fullName}`),
    );
    for (const name of skipped) console.error(`skipped: ${name}`);
    if (skipped.length > 0) process.exitCode = 1;
  }
}
