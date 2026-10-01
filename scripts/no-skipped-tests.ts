import type { Reporter, TestModule, Vitest } from "vitest/node";

// Vitest reports filtered-out tests as skipped, so a name-filtered run is
// exempt.
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
