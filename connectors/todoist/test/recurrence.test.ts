import { describe, expect, it } from "vitest";
import { recurrenceRules } from "../src/recurrence.js";
import { entryOf, type TodoistItem } from "../src/todoist.js";

type Due = NonNullable<TodoistItem["due"]>;

function rules(
  string: string,
  dueAt: string,
  timezone = "UTC",
  more: Partial<Due> = {},
): string[] | undefined {
  const due: Due = {
    date: dueAt,
    string,
    lang: "en",
    is_recurring: true,
    timezone,
    ...more,
  };
  return recurrenceRules(due, dueAt, timezone);
}

describe("a recurring due as RFC 5545 lines", () => {
  it("states the repeats it can state exactly", () => {
    const at = "2026-10-05T14:00:00.000Z"; // a Monday, in UTC
    expect(rules("every day at 2pm", at)).toEqual(["RRULE:FREQ=DAILY"]);
    expect(rules("every 3 days", at)).toEqual(["RRULE:FREQ=DAILY;INTERVAL=3"]);
    expect(rules("every other week", at)).toEqual([
      "RRULE:FREQ=WEEKLY;INTERVAL=2",
    ]);
    expect(rules("every weekday at 14:00", at)).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    ]);
    expect(rules("every mon, wed and fri", at)).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR",
    ]);
    expect(rules("every 2 months", at)).toEqual([
      "RRULE:FREQ=MONTHLY;INTERVAL=2",
    ]);
    expect(rules("every 5th", at)).toEqual(["RRULE:FREQ=MONTHLY;BYMONTHDAY=5"]);
    expect(rules("every year", at)).toEqual(["RRULE:FREQ=YEARLY"]);
  });

  it("reads a hostile 100,000-character due string in linear time", () => {
    const at = "2026-10-05T14:00:00.000Z";
    const hostile = [
      `every mon${" ".repeat(100_000)}!`,
      `every day${" at".repeat(33_333)}`,
      `every day${" at ".repeat(25_000)}x`,
      `every ${"a,".repeat(50_000)}!`,
      `every ${"a ,".repeat(33_333)}!`,
      `every ${"a and ".repeat(16_666)}!`,
      `every a${" & a".repeat(33_333)}!`,
      `every day at ${"1".repeat(100_000)}`,
      `every day${"\t ".repeat(50_000)}at`,
    ];
    const started = performance.now();
    for (const text of hostile) {
      expect(text.length).toBeGreaterThanOrEqual(99_999);
      expect(rules(text, at)).toBeUndefined();
    }
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("moves a weekday to the day it falls on in UTC", () => {
    // 07:00 on a Monday in Tokyo is 22:00 on the Sunday before, in UTC.
    expect(
      rules("every monday at 7am", "2026-10-04T22:00:00.000Z", "Asia/Tokyo"),
    ).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=SU"]);
  });

  it("states nothing it cannot state exactly", () => {
    const at = "2026-10-05T14:00:00.000Z";
    // Counted from completion, not from the calendar.
    expect(rules("every! day", at)).toBeUndefined();
    // A start or an end.
    expect(rules("every day starting oct 7", at)).toBeUndefined();
    expect(rules("every day until dec 1", at)).toBeUndefined();
    // A clock time the date does not carry.
    expect(rules("every day at 9am", at)).toBeUndefined();
    // Words it does not read.
    expect(rules("every flibbertigibbet", at)).toBeUndefined();
    expect(rules("jeden Tag", at, "UTC", { lang: "de" })).toBeUndefined();
    // A day of the month that not every month has.
    expect(rules("every 31st", "2026-10-31T14:00:00.000Z")).toBeUndefined();
    // A zone whose offset changes in the year: the wall time would drift in UTC.
    expect(
      rules("every day at 3pm", "2026-10-05T14:00:00.000Z", "Europe/London"),
    ).toBeUndefined();
    // Not a repeat.
    expect(
      rules("every day", at, "UTC", { is_recurring: false }),
    ).toBeUndefined();
  });

  it("keeps Todoist's words whether or not rules are stated", () => {
    const task = (due: Due): TodoistItem => ({
      id: "a",
      content: "Task a",
      checked: false,
      due,
    });
    const exact = entryOf(
      "1",
      "UTC",
      task({
        date: "2026-10-05T14:00:00.000000Z",
        string: "every day at 2pm",
        lang: "en",
        is_recurring: true,
        timezone: "UTC",
      }),
    ).properties;
    expect(exact["recurrence"]).toEqual(["RRULE:FREQ=DAILY"]);
    expect(exact["recurrence_text"]).toBe("every day at 2pm");
    const inexact = entryOf(
      "1",
      "UTC",
      task({
        date: "2026-10-05T14:00:00.000000Z",
        string: "every! day at 2pm",
        lang: "en",
        is_recurring: true,
        timezone: "UTC",
      }),
    ).properties;
    expect(inexact["recurrence"]).toBeUndefined();
    expect(inexact["recurrence_text"]).toBe("every! day at 2pm");
  });
});
