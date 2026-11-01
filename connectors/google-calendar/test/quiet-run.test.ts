import { start } from "../../../kit/src/main.js";
import { Harness } from "../../../kit/test/harness.js";
import { quietRun } from "../../../kit/test/quiet-run.js";
import { ScriptedServer } from "../../../kit/test/scripted-server.js";
import {
  clientEnv,
  freshToken,
  GoogleStub,
} from "../../../shared/google/test/stub.js";
import {
  calendarListScope,
  calendarType,
  eventsScope,
  eventType,
  inCalendar,
} from "../src/config.js";
import { createConnector } from "../src/connector.js";
import { CalendarStub } from "./calendar-stub.js";

const me = "me@example.com";

quietRun({
  sizes: [20, 420],
  async hold(size) {
    const marfa = await new ScriptedServer("google-calendar", {
      types: [calendarType, eventType],
      edges: [inCalendar, "parent-of"],
    }).start();
    marfa.grants = {
      metadata_permissions: { types: "write", edge_types: "write" },
    };
    const harness = new Harness(marfa);
    const google = await new GoogleStub().start();
    google.scope = `openid ${eventsScope} ${calendarListScope}`;
    const calendar = await new CalendarStub().start();
    calendar.calendars = [
      {
        id: me,
        summary: "Me",
        timeZone: "Europe/London",
        accessRole: "owner",
        primary: true,
      },
    ];
    for (let at = 0; at < size; at += 1) {
      const day = new Date(Date.UTC(2026, 9, 1) + at * 3_600_000);
      calendar.put(me, {
        id: `event${String(at)}`,
        summary: `Event ${String(at)}`,
        start: { dateTime: day.toISOString(), timeZone: "Europe/London" },
        end: {
          dateTime: new Date(day.getTime() + 1_800_000).toISOString(),
          timeZone: "Europe/London",
        },
      });
    }
    return {
      marfa,
      async run() {
        const code = await start(
          createConnector({
            endpoints: { ...google.endpoints, api: calendar.url },
          }),
          harness.runtime(["--once"], {
            ...clientEnv,
            GOOGLE_REFRESH_TOKEN: freshToken(),
          }),
        );
        if (code !== 0) throw new Error(`the run exited ${String(code)}`);
      },
      async stop() {
        await marfa.stop();
        await google.stop();
        await calendar.stop();
      },
    };
  },
});
