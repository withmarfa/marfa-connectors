import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestModule } from "vitest/node";
import config from "../../vitest.config.js";
import { RetriedTests } from "../retried-tests.js";

function module(tests: { fullName: string; flaky: boolean | undefined }[]) {
  return {
    moduleId: "kit/test/example.test.ts",
    children: {
      *allTests() {
        for (const test of tests) {
          yield {
            fullName: test.fullName,
            diagnostic: () =>
              test.flaky === undefined ? undefined : { flaky: test.flaky },
          };
        }
      },
    },
  } as unknown as TestModule;
}

describe("the report of retried tests", () => {
  let directory = "";
  let said: string[] = [];
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "connectors-retried-"));
    process.env["GITHUB_STEP_SUMMARY"] = join(directory, "summary.md");
    said = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => {
      said.push(line);
    });
  });
  afterEach(() => {
    if (summary === undefined) delete process.env["GITHUB_STEP_SUMMARY"];
    else process.env["GITHUB_STEP_SUMMARY"] = summary;
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const read = () => {
    try {
      return readFileSync(join(directory, "summary.md"), "utf8");
    } catch {
      return "";
    }
  };

  it("lists a test that passed on a retry in the summary and as a warning", () => {
    new RetriedTests().onTestRunEnd([
      module([
        { fullName: "a > steady", flaky: false },
        { fullName: "a > shaky", flaky: true },
        { fullName: "a > untracked", flaky: undefined },
      ]),
    ]);
    expect(read()).toContain("- `kit/test/example.test.ts > a > shaky`");
    expect(read()).not.toContain("steady");
    expect(read()).not.toContain("untracked");
    expect(said.some((line) => line.startsWith("::warning"))).toBe(true);
  });

  it("says nothing when no test needed a retry", () => {
    new RetriedTests().onTestRunEnd([
      module([{ fullName: "a > steady", flaky: false }]),
    ]);
    expect(read()).toBe("");
    expect(said).toEqual([]);
  });

  it("is configured with one retry in CI and none elsewhere", () => {
    const retry = config.test?.retry;
    expect(retry).toBe(process.env["CI"] === undefined ? 0 : 1);
    expect(config.test?.reporters).toContainEqual(expect.any(RetriedTests));
  });
});
