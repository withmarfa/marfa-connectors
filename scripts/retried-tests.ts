import { appendFileSync } from "node:fs";
import type { Reporter, TestModule } from "vitest/node";

/**
 * Lists the tests that failed and then passed on a retry, in the job summary
 * and as a warning, so a retry never hides a flaky test. A test that failed
 * every attempt fails the run as Vitest reports it.
 */
export class RetriedTests implements Reporter {
  onTestRunEnd(testModules: readonly TestModule[]): void {
    const retried = testModules.flatMap((module) =>
      [...module.children.allTests()]
        .filter((test) => test.diagnostic()?.flaky === true)
        .map((test) => `${module.moduleId} > ${test.fullName}`),
    );
    if (retried.length === 0) return;
    for (const name of retried) console.error(`retried: ${name}`);
    const summary = process.env["GITHUB_STEP_SUMMARY"];
    if (summary !== undefined && summary !== "") {
      appendFileSync(
        summary,
        `### Tests that passed only on a retry\n\n${retried.map((name) => `- \`${name}\``).join("\n")}\n\nA test reported here more than once needs an issue and a fix.\n`,
      );
    }
    const warning = `${String(retried.length)} test(s) passed only on a retry: ${retried.join("; ")}`;
    console.error(
      `::warning title=Flaky tests::${warning.replace(/\r?\n/g, " ")}`,
    );
  }
}
