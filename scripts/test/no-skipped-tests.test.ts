import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestModule, Vitest } from "vitest/node";
import config from "../../vitest.config.js";
import { NoSkippedTests } from "../no-skipped-tests.js";

interface Entry {
  fullName: string;
  state: "passed" | "skipped";
}

/** A finished test file as the reporter is handed it, with only what it reads. */
function module(suites: Entry[], tests: Entry[]): TestModule {
  return {
    moduleId: "kit/test/example.test.ts",
    children: {
      *allSuites() {
        for (const suite of suites) {
          yield { fullName: suite.fullName, state: () => suite.state };
        }
      },
      *allTests(state?: string) {
        for (const test of tests) {
          if (state === undefined || test.state === state) {
            yield { fullName: test.fullName };
          }
        }
      },
    },
  } as unknown as TestModule;
}

function held(
  modules: TestModule[],
  namePattern?: RegExp,
): typeof process.exitCode {
  const reporter = new NoSkippedTests();
  reporter.onInit({
    config: { testNamePattern: namePattern },
  } as unknown as Vitest);
  process.exitCode = undefined;
  reporter.onTestRunEnd(modules);
  return process.exitCode;
}

describe("the skipped-test gate", () => {
  const exitCode = process.exitCode;
  let said: string[] = [];
  beforeEach(() => {
    said = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => {
      said.push(line);
    });
  });
  afterEach(() => {
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  });

  it("fails a run with a skipped test or a skipped suite, and passes one with neither", () => {
    const passed = { fullName: "a > runs", state: "passed" } as const;
    const skipped = { fullName: "a > waits", state: "skipped" } as const;
    expect(held([module([], [passed])])).toBeUndefined();
    expect(held([module([], [passed, skipped])])).toBe(1);
    expect(held([module([skipped], [passed])])).toBe(1);
    expect(said).toEqual([
      "skipped: kit/test/example.test.ts > a > waits",
      "skipped: kit/test/example.test.ts > a > waits",
    ]);
  });

  it("leaves a run given a name filter alone", () => {
    const skipped = { fullName: "a > waits", state: "skipped" } as const;
    expect(held([module([], [skipped])], /runs/)).toBeUndefined();
  });

  it("is one of the reporters every test run uses", () => {
    const reporters: unknown[] = [config.test?.reporters].flat();
    expect(
      reporters.some((reporter) => reporter instanceof NoSkippedTests),
    ).toBe(true);
  });
});
