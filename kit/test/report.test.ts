import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Harness, secretToken, vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

const one = { source_id: "a:1", properties: { title: "One" } };
const two = { source_id: "a:2", properties: { title: "Two" } };

describe("a run's report", () => {
  it("carries the counts as its summary, with when it started and finished", async () => {
    await harness.once(vendor([one, two]));
    const run = harness.lastRun();
    expect(run.outcome).toBe("succeeded");
    expect(run.summary).toBe(
      "created 2, updated 0, archived 0, unchanged 0, skipped 0",
    );
    expect(run.error).toBeUndefined();
    expect(Date.parse(run.finished_at)).toBeGreaterThanOrEqual(
      Date.parse(run.started_at),
    );
  });

  it("is stamped finished when the run finishes, not when it starts", async () => {
    const held = vendor([one]);
    let release = (): void => undefined;
    held.gate = new Promise((resolve) => {
      release = resolve;
    });
    const running = harness.once(held);
    await vi.waitFor(() => {
      expect(held.runs).toBe(1);
    });
    harness.clock.advance(5000);
    release();
    expect(await running).toBe(0);
    const run = harness.lastRun();
    expect(Date.parse(run.finished_at) - Date.parse(run.started_at)).toBe(5000);
  });

  it("carries a failure's text, capped to what the server takes", async () => {
    const failing = vendor([one]);
    failing.fail = new Error(`the vendor answered: ${"x".repeat(5000)}`);
    expect(await harness.once(failing)).toBe(1);
    const run = harness.lastRun();
    expect(run.outcome).toBe("failed");
    expect(run.error).toMatch(/^the vendor answered: x+/);
    expect(run.error?.length).toBeLessThanOrEqual(2000);
    expect(run.summary).toBe(
      "created 0, updated 0, archived 0, unchanged 0, skipped 0",
    );
  });

  it("is reported once per run, and a run is never retried inside itself", async () => {
    const failing = vendor([one]);
    failing.fail = new Error("the vendor answered 503");
    await harness.once(failing);
    expect(failing.runs).toBe(1);
    expect(harness.server.runs).toHaveLength(1);
  });
});

describe("a condition", () => {
  const warnedOf = (text: string): number =>
    harness.lines.filter(
      (line) => line.includes(" warn ") && line.includes(text),
    ).length;

  it("keeps only conditions whose checks were not reached, for this run alone", async () => {
    const held = vendor([]);
    held.conditions = [
      ["issues-off:A", "A disabled"],
      ["issues-off:B", "B disabled"],
    ];
    await harness.once(held);
    held.conditions = [];
    held.unreached = { keys: ["issues-off:A"] };
    await harness.once(held);
    expect(harness.lastRun().summary).toContain("A disabled");
    expect(harness.lastRun().summary).not.toContain("B disabled");
    held.unreached = {};
    await harness.once(held);
    expect(harness.lastRun().summary).not.toContain("A disabled");
  });

  it("matches exact keys and literal prefixes, accumulating selectors without replacing raised messages", async () => {
    const held = vendor([]);
    held.conditions = [
      ["x:A", "A"],
      ["x:AB", "AB"],
      ["family.[a]:one", "family"],
      ["familyXa:one", "neighbor"],
    ];
    await harness.once(held);
    held.conditions = [["x:A", "A updated"]];
    held.unreached = {
      keys: ["x:A", "x:A"],
      prefixes: ["family.[a]:", "family.[a]:"],
    };
    await harness.once(held);
    expect(harness.lastRun().summary).toContain("A updated");
    expect(harness.lastRun().summary).toContain("family");
    expect(harness.lastRun().summary).not.toContain("AB");
    expect(harness.lastRun().summary).not.toContain("neighbor");
    expect(harness.server.states.get("test")).not.toHaveProperty("unreached");
  });

  it("retains reached and unreached conditions after failure and emits no clearance on refused saves", async () => {
    const held = vendor([]);
    held.conditions = [
      ["x:A", "A problem"],
      ["x:B", "B problem"],
    ];
    await harness.once(held);
    held.conditions = [];
    held.unreached = { keys: ["x:A"] };
    held.fail = new Error("vendor down");
    expect(await harness.once(held)).toBe(1);
    expect(harness.lastRun().summary).toContain("A problem");
    expect(harness.lastRun().summary).toContain("B problem");
    held.fail = undefined;
    harness.server.refuseNext(
      "PUT /connectors/connector-1/state",
      400,
      "validation_error",
    );
    expect(await harness.once(held)).toBe(1);
    expect(harness.lines.filter((line) => line.includes("cleared:"))).toEqual(
      [],
    );
  });

  it("redacts selectors like stored keys", async () => {
    const held = vendor([]);
    held.conditions = [[`feed:${secretToken}`, "secret feed problem"]];
    await harness.once(held);
    held.conditions = [];
    held.unreached = { prefixes: [`feed:${secretToken}`] };
    await harness.once(held);
    expect(harness.lastRun().summary).toContain("secret feed problem");
    expect(JSON.stringify(harness.server.states.get("test"))).not.toContain(
      secretToken,
    );
    expect(harness.lines.join("\n")).not.toContain(secretToken);
  });

  it("is reported and warned on every run it holds, and said to be cleared when it stops", async () => {
    const held = vendor([one]);
    held.conditions = [["feed-gone:x", "the feed x answers 410"]];
    await harness.once(held);
    expect(harness.lastRun().summary).toBe(
      "created 1, updated 0, archived 0, unchanged 0, skipped 0. the feed x answers 410",
    );
    expect(warnedOf("the feed x answers 410")).toBe(1);

    await harness.once(held);
    expect(harness.lastRun().summary).toBe(
      "created 0, updated 0, archived 0, unchanged 1, skipped 0. the feed x answers 410",
    );
    await harness.once(held);
    expect(harness.lastRun().summary).toContain("the feed x answers 410");
    expect(warnedOf("the feed x answers 410")).toBe(3);

    held.conditions = [];
    await harness.once(held);
    expect(harness.lastRun().summary).not.toContain("the feed x answers 410");
    expect(
      harness.lines.filter((line) => line.includes("cleared")),
    ).toHaveLength(1);

    held.conditions = [["feed-gone:x", "the feed x answers 410"]];
    await harness.once(held);
    expect(harness.lastRun().summary).toContain("the feed x answers 410");
  });

  it("stands through a failed run, which reports it, without being said to have cleared", async () => {
    const held = vendor([one]);
    held.conditions = [["feed-gone:x", "the feed x answers 410"]];
    await harness.once(held);
    held.conditions = [];
    held.fail = new Error("the vendor is down");
    expect(await harness.once(held)).toBe(1);
    expect(harness.lastRun().outcome).toBe("failed");
    expect(harness.lastRun().summary).toContain("the feed x answers 410");
    expect(warnedOf("the feed x answers 410")).toBe(2);
    expect(harness.lines.some((line) => line.includes("cleared"))).toBe(false);

    held.fail = undefined;
    await harness.once(held);
    expect(harness.lastRun().summary).not.toContain("the feed x answers 410");
    expect(
      harness.lines.filter((line) => line.includes("cleared")),
    ).toHaveLength(1);
  });

  it("is reported on the next run when the report that carried it did not land", async () => {
    const held = vendor([one]);
    held.conditions = [["feed-gone:x", "the feed x answers 410"]];
    harness.server.refuseNext(
      "POST /connectors/connector-1/runs",
      503,
      "unavailable",
    );
    await harness.once(held);
    expect(harness.server.runs).toEqual([]);
    await harness.once(held);
    expect(harness.lastRun().summary).toContain("the feed x answers 410");
  });
});

describe("a state the server will not keep", () => {
  it("fails the run, in its report and its exit code, reported once the save was refused", async () => {
    const held = vendor([one]);
    held.token = "x".repeat(600 * 1024);
    expect(await harness.once(held)).toBe(1);
    const run = harness.lastRun();
    expect(run.outcome).toBe("failed");
    expect(run.error).toContain("the connector's state could not be kept");
    expect(run.error).toContain("a state is at most 512 KiB");
    const order = harness.server.requests
      .filter(
        (request) =>
          (request.method === "PUT" &&
            request.path === "/connectors/connector-1/state") ||
          (request.method === "POST" &&
            request.path === "/connectors/connector-1/runs"),
      )
      .map((request) => request.method);
    expect(order).toEqual(["PUT", "POST"]);
    expect(harness.kept()).toEqual({});
  });

  it("fails the run where the server refuses the save for any other reason", async () => {
    harness.server.refuseNext(
      "PUT /connectors/connector-1/state",
      400,
      "validation_error",
    );
    expect(await harness.once(vendor([one]))).toBe(1);
    expect(harness.lastRun().outcome).toBe("failed");
    expect(harness.lines.some((line) => line.includes("run succeeded"))).toBe(
      false,
    );
  });
});

describe("a run stopped part-way", () => {
  const stoppedPartWay = async (
    afterStop: (held: ReturnType<typeof vendor>) => void,
  ): Promise<number> => {
    const held = vendor([one]);
    let release = (): void => undefined;
    held.gate = new Promise((resolve) => {
      release = resolve;
    });
    const running = harness.once(held);
    await vi.waitFor(() => {
      expect(held.runs).toBe(1);
    });
    harness.stop();
    afterStop(held);
    release();
    return running;
  };

  it("is not reported, and the log says it was stopped", async () => {
    expect(await stoppedPartWay(() => undefined)).toBe(0);
    expect(harness.server.runs).toEqual([]);
    const said = harness.lines.join("\n");
    expect(said).toContain("run stopped before it finished");
    expect(said).not.toContain("run failed");
  });

  it("is not reported where the stop aborted the vendor's own call", async () => {
    expect(
      await stoppedPartWay((held) => {
        held.fail = new DOMException(
          "This operation was aborted",
          "AbortError",
        );
      }),
    ).toBe(0);
    expect(harness.server.runs).toEqual([]);
    expect(harness.lines.join("\n")).not.toContain("run failed");
  });

  it("keeps what it had, so the next run carries on from it", async () => {
    await harness.once(vendor([one]));
    const saves = harness.server.requestsTo(
      "PUT",
      "/connectors/connector-1/state",
    ).length;
    expect(await stoppedPartWay(() => undefined)).toBe(0);
    expect(
      harness.server.requestsTo("PUT", "/connectors/connector-1/state").length,
    ).toBeGreaterThan(saves);
    expect(await harness.once(vendor([one, two]))).toBe(0);
    expect(harness.lastRun().summary).toBe(
      "created 1, updated 0, archived 0, unchanged 1, skipped 0",
    );
  });
});

describe("secrets", () => {
  it("never reach a log line, a summary or an error", async () => {
    const leaky = vendor([one]);
    leaky.logs = [`calling the vendor with ${secretToken}`];
    leaky.conditions = [
      ["token", `the token ${secretToken} is about to expire`],
    ];
    leaky.fail = new Error(
      `401 for Bearer ${secretToken} and key ${harness.server.key}`,
    );
    await harness.once(leaky);

    const reported = harness.server.runs.map(
      (run) => `${run.summary ?? ""} ${run.error ?? ""}`,
    );
    for (const text of [...harness.lines, ...reported]) {
      expect(text).not.toContain(secretToken);
      expect(text).not.toContain(harness.server.key);
    }
    expect(harness.lines.join("\n")).toContain(
      "calling the vendor with [redacted]",
    );
    expect(harness.lastRun().error).toContain(
      "401 for Bearer [redacted] and key [redacted]",
    );
  });

  it("never reach a warning, which is redacted like every other line", async () => {
    const leaky = vendor([one]);
    leaky.warnings = [`retrying the vendor with ${secretToken}`];
    await harness.once(leaky);
    const warned = harness.lines.filter((line) => line.includes(" warn "));
    expect(warned.join("\n")).toContain("retrying the vendor with [redacted]");
    for (const line of harness.lines) expect(line).not.toContain(secretToken);
  });

  it("never reach a run's reported error, spelled as a URL carries it", async () => {
    const token = "tok/with+marks=value";
    const failing = vendor([one]);
    failing.fail = new Error(
      `GET https://vendor.example.com/?token=${encodeURIComponent(token)} answered 401`,
    );
    expect(await harness.once(failing, { TEST_TOKEN: token })).toBe(1);
    const error = harness.lastRun().error ?? "";
    expect(error).toContain("?token=[redacted] answered 401");
    expect(error).not.toContain(encodeURIComponent(token));
  });

  it("never reach a start's reported problem, spelled as a URL carries it", async () => {
    const token = "tok/with+marks=value";
    harness.server.refuseNext(
      "POST /types",
      403,
      "forbidden",
      `no metadata.types:write for ?token=${encodeURIComponent(token)}`,
    );
    expect(await harness.once(vendor([one]), { TEST_TOKEN: token })).toBe(1);
    const error = harness.lastRun().error ?? "";
    expect(error).toContain("?token=[redacted]");
    expect(error).not.toContain(encodeURIComponent(token));
  });

  it("never reach the kept state through a condition's key", async () => {
    const held = vendor([one]);
    held.conditions = [[`expiring:${secretToken}`, "the token expires soon"]];
    await harness.once(held);
    expect(harness.lastRun().summary).toContain("the token expires soon");
    const stored = JSON.stringify(harness.kept());
    expect(stored).toContain("expiring:[redacted]");
    expect(stored).not.toContain(secretToken);
  });

  it("are replaced whole where one secret holds another", async () => {
    const token = `${harness.server.key}-and-more`;
    const leaky = vendor([one]);
    leaky.logs = [`using ${token} now`];
    await harness.once(leaky, { TEST_TOKEN: token });
    const said = harness.lines.join("\n");
    expect(said).toContain("using [redacted] now");
    expect(said).not.toContain("-and-more");
  });

  it("never reach a line in the other spellings a URL or a form carries", async () => {
    const token = "tok/with+marks=v (1)";
    const lower = encodeURIComponent(token).replace(/%[0-9A-F]{2}/g, (escape) =>
      escape.toLowerCase(),
    );
    const form = new URLSearchParams({ t: token }).toString().slice(2);
    expect(form).not.toBe(encodeURIComponent(token));
    const leaky = vendor([one]);
    leaky.logs = [`GET /?a=${lower}`, `POST t=${form}`];
    await harness.once(leaky, { TEST_TOKEN: token });
    const said = harness.lines.join("\n");
    expect(said).toContain("GET /?a=[redacted]");
    expect(said).toContain("POST t=[redacted]");
    expect(said).not.toContain(lower);
    expect(said).not.toContain(form);
  });

  it("are each redacted where a secret holds a list and one of its parts appears alone", async () => {
    const list =
      "https://feeds.example.com/private/first-token/a.xml https://feeds.example.com/private/second-token/b.xml";
    const leaky = vendor([one]);
    leaky.logs = [
      "fetching https://feeds.example.com/private/second-token/b.xml",
      `encoded ${encodeURIComponent("https://feeds.example.com/private/second-token/b.xml")}`,
    ];
    leaky.fail = new Error(
      `https://feeds.example.com/private/first-token/a.xml answered 500`,
    );
    await harness.once(leaky, { TEST_TOKEN: list });
    const reported = harness.lastRun().error ?? "";
    for (const text of [...harness.lines, reported]) {
      expect(text).not.toContain("first-token");
      expect(text).not.toContain("second-token");
    }
    expect(harness.lines.join("\n")).toContain("fetching [redacted]");
    expect(harness.lines.join("\n")).toContain("encoded [redacted]");
    expect(reported).toContain("[redacted] answered 500");
  });

  it("are each redacted where a list is set apart by commas, down to eight characters", async () => {
    const leaky = vendor([one]);
    leaky.logs = ["first second-part-value", "code 12345678 used"];
    await harness.once(leaky, {
      TEST_TOKEN: "first-part-value,second-part-value, 12345678",
    });
    const said = harness.lines.join("\n");
    expect(said).toContain("first [redacted]");
    expect(said).not.toContain("second-part-value");
    expect(said).toContain("code [redacted] used");
  });

  it("never reach the kept state, nor a URL that carries one encoded", async () => {
    const token = "tok/with+marks=value";
    const leaky = vendor([one]);
    leaky.logs = [
      `GET https://vendor.example.com/?token=${encodeURIComponent(token)}`,
    ];
    leaky.conditions = [["token", `the token ${token} is about to expire`]];
    await harness.once(leaky, { TEST_TOKEN: token });
    expect(JSON.stringify(harness.kept())).not.toContain(token);
    expect(JSON.stringify(harness.kept())).toContain(
      "[redacted] is about to expire",
    );
    const said = harness.lines.join("\n");
    expect(said).not.toContain(encodeURIComponent(token));
    expect(said).toContain("?token=[redacted]");
  });
});
