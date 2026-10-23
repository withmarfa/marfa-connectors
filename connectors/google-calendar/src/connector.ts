import {
  defineConnector,
  type ConnectionDefinition,
  type TypeDefinition,
} from "@withmarfa/connector";
import { connectGoogle, signIn, type GoogleOptions } from "@withmarfa/google";
import { CalendarApi } from "./api.js";
import {
  calendarDefinition,
  calendarFields,
  calendarListScope,
  calendarType,
  childOf,
  env,
  eventDefinition,
  eventFields,
  eventType,
  inCalendar,
  scopes,
  source,
} from "./config.js";
import { calendarChecks, readCalendars } from "./read.js";

const connections: ConnectionDefinition[] = [
  {
    id: inCalendar,
    label: "On calendar",
    description: "A Google Calendar event on the calendar it belongs to.",
    cardinality: "many-to-one",
    source_type_constraints: [eventType],
    target_type_constraints: [calendarType],
  },
  {
    id: childOf,
    label: "Child of",
    description:
      "A changed occurrence of a Google Calendar series, beneath the series.",
    cardinality: "many-to-one",
    cascade_on_delete: "cascade",
    source_type_constraints: [eventType],
    target_type_constraints: [eventType],
  },
];

function names(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(/[\s,]+/)
      .map((one) => one.trim())
      .filter((one) => one !== ""),
  );
}

/** The connector; a test passes the address of its stub of Google. */
export function createConnector(options?: GoogleOptions) {
  const base = `${options?.endpoints?.api ?? "https://www.googleapis.com"}/calendar/v3`;
  return defineConnector({
    name: "google-calendar",
    description:
      "Calendars and events of a Google account, read through the Calendar API, read only.",
    source,
    readme: "connectors/google-calendar/README.md",
    types: [
      { type: calendarDefinition as TypeDefinition, fields: calendarFields },
      { type: eventDefinition as TypeDefinition, fields: eventFields },
    ],
    connections,
    env,
    setup: (context) => signIn(context, scopes, options),
    async run(context) {
      const google = connectGoogle(
        context,
        { source, scopes, types: [calendarType, eventType] },
        options,
      );
      const access = await google.ready();
      if (!access.has(calendarListScope)) {
        // Nothing is read, so every check of the calendars is skipped.
        context.log.unreached({ prefixes: [...calendarChecks] });
        return;
      }
      await readCalendars({
        context,
        api: new CalendarApi(google, base),
        access,
        named: names(context.env.GOOGLE_CALENDAR_READ_ONLY_CALENDARS),
        now: options?.now ?? Date.now,
      });
    },
  });
}
