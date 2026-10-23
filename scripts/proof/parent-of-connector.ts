import { appendFileSync } from "node:fs";
import { defineConnector, main, type Entry } from "@withmarfa/connector";

const source = "proof-parent-of";
const type = "proof.parent.event";
const journal = process.env["PROOF_JOURNAL"] ?? "";

/** The calendar's occurrences, as `id:series` pairs; no series is a plain
 *  event or a series itself. */
function entries(): Entry[] {
  const held = JSON.parse(process.env["PROOF_EVENTS"] ?? "[]") as [
    string,
    string?,
  ][];
  return held.map(([id, series]) => ({
    source_id: id,
    properties: { title: `Event ${id}`, vendor_id: `v-${id}` },
    ...(series !== undefined && {
      connections: { "child-of": [{ type, id: `v-${series}` }] },
    }),
  }));
}

void main(
  defineConnector({
    name: source,
    description: "The proof's calendar, whose exceptions name their series.",
    source,
    types: [
      {
        type: {
          id: type,
          label: "Event",
          description: "A calendar event or one occurrence of a series.",
          link_field: "vendor_id",
          fields: {
            title: { type: "string", required: true },
            vendor_id: { type: "string" },
          },
        },
        fields: ["title", "vendor_id"],
      },
    ],
    connections: [
      {
        id: "child-of",
        cardinality: "many-to-one",
        cascade_on_delete: "cascade",
        source_type_constraints: [type],
        target_type_constraints: [type],
      },
    ],
    async run(context) {
      await context.upsert(type, entries());
    },
    onChange(change) {
      appendFileSync(
        journal,
        `${JSON.stringify({
          kind: change.kind,
          event: change.item.source_id,
          added: (change.connections?.["child-of"]?.added ?? []).map(
            (row) => row.source_id,
          ),
          removed: (change.connections?.["child-of"]?.removed ?? []).map(
            (row) => row.source_id,
          ),
        })}\n`,
      );
      return Promise.resolve(undefined);
    },
  }),
);
