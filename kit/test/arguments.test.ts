import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../src/environment.js";
import { defaultLookMs, readSchedule, usage } from "../src/schedule.js";

function refused(argv: string[]): string {
  try {
    readSchedule(argv);
  } catch (error) {
    if (error instanceof ConfigurationError) return error.message;
    throw error;
  }
  throw new Error(`${argv.join(" ")} was read as a schedule`);
}

describe("the schedule arguments", () => {
  it("reads each mode", () => {
    expect(readSchedule(["--help"])).toEqual({ mode: "help" });
    expect(readSchedule(["-h"])).toEqual({ mode: "help" });
    expect(readSchedule(["--once"])).toEqual({ mode: "once" });
    expect(readSchedule(["--setup", "keys.env"])).toEqual({
      mode: "setup",
      file: "keys.env",
    });
    expect(readSchedule(["--every", "15m"])).toEqual({
      mode: "every",
      intervalMs: 900_000,
      lookMs: defaultLookMs,
      lookGiven: false,
    });
    expect(readSchedule(["--every", "1h", "--look-every", "30s"])).toEqual({
      mode: "every",
      intervalMs: 3_600_000,
      lookMs: 30_000,
      lookGiven: true,
    });
  });

  it("reads a value joined to its flag with an equals sign", () => {
    expect(readSchedule(["--every=15m", "--look-every=30s"])).toMatchObject({
      intervalMs: 900_000,
      lookMs: 30_000,
    });
    expect(readSchedule(["--setup=keys.env"])).toEqual({
      mode: "setup",
      file: "keys.env",
    });
  });

  it("says what to run it with, and names what it got", () => {
    expect(refused([])).toBe(`no schedule was given: ${usage}`);
    expect(refused(["--every", "soon"])).toBe(`${usage}; got "--every soon"`);
  });

  it.each([
    ["an interval with no unit", ["--every", "15"]],
    ["an interval in an unknown unit", ["--every", "1d"]],
    ["an interval of zero", ["--every", "0m"]],
    ["an interval with a leading zero", ["--every", "05m"]],
    ["a fractional interval", ["--every", "1.5h"]],
    ["a negative interval", ["--every", "-5m"]],
    ["a negative interval joined to its flag", ["--every=-5m"]],
    ["an interval in capitals", ["--every", "15M"]],
    ["an empty interval", ["--every="]],
    ["--every with no interval", ["--every"]],
    ["a malformed look interval", ["--every", "15m", "--look-every", "often"]],
    ["--look-every with no interval", ["--every", "15m", "--look-every"]],
    ["--look-every alone", ["--look-every", "30s"]],
    ["--look-every without --every", ["--once", "--look-every", "30s"]],
    ["--look-every before --every", ["--look-every", "30s", "--every", "15m"]],
    ["--every given twice", ["--every", "5m", "--every", "10m"]],
    [
      "--look-every given twice",
      ["--every", "5m", "--look-every", "5s", "--look-every", "6s"],
    ],
    ["--once and --every", ["--once", "--every", "15m"]],
    ["--once given twice", ["--once", "--once"]],
    ["--help beside another flag", ["--help", "--once"]],
    ["--help given a value", ["--help=now"]],
    ["--setup with no file", ["--setup"]],
    ["--setup with an empty file", ["--setup="]],
    ["--setup beside --once", ["--setup", "keys.env", "--once"]],
    ["a word that is not a flag", ["now"]],
    ["a word after a schedule", ["--every", "15m", "now"]],
    ["a flag it does not know", ["--every", "15m", "--deliver-every", "30s"]],
    ["a flag in capitals", ["--Once"]],
    ["a shortened flag", ["--on"]],
    ["the end of flags alone", ["--"]],
    ["words after the end of flags", ["--once", "--", "now"]],
    ["an empty word", [""]],
  ])("refuses %s", (_name, argv) => {
    expect(refused(argv)).toBe(`${usage}; got "${argv.join(" ")}"`);
  });
});
