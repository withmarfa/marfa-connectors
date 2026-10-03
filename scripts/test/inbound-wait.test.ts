import { describe, expect, it } from "vitest";
import {
  deliverySettled,
  restorationSettled,
  type InboundObservation,
} from "../proof/inbound-wait.js";

const oldReport: InboundObservation = {
  rowReady: true,
  vendorRequests: [],
  deliveryProcessed: false,
  reportedAt: "before",
  summary:
    "created 1, updated 0, deliveries processed 1, rejected 0, duplicate 0",
};

describe("inbound proof waits for the work its assertion observes", () => {
  it("witnesses the old row-only wait accepting a restoration before its report", () => {
    expect(oldReport.rowReady).toBe(true);
    expect(oldReport.summary).not.toContain(
      "title on t2 was changed in Marfa and put back",
    );
    expect(restorationSettled(oldReport, "before", "t2")).toBe(false);
    expect(
      restorationSettled(
        {
          ...oldReport,
          reportedAt: "after",
          summary: "title on t2 was changed in Marfa and put back",
        },
        "before",
        "t2",
      ),
    ).toBe(true);
  });

  it("requires the row, named vendor request, processed delivery and new matching report", () => {
    const settled = {
      ...oldReport,
      vendorRequests: ["/things/t3"],
      deliveryProcessed: true,
      reportedAt: "after",
    };
    expect(deliverySettled(settled, "before", "/things/t3")).toBe(true);
    for (const missing of [
      { rowReady: false },
      { vendorRequests: [] },
      { deliveryProcessed: false },
      { reportedAt: "before" },
      { summary: "deliveries processed 0, rejected 0, duplicate 0" },
    ])
      expect(
        deliverySettled({ ...settled, ...missing }, "before", "/things/t3"),
      ).toBe(false);
  });
});
