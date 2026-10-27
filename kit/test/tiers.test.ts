import { createClient } from "@withmarfa/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Marfa } from "../src/marfa.js";
import { Harness, vendor } from "./harness.js";

let harness: Harness;
beforeEach(async () => {
  harness = await Harness.create();
});
afterEach(async () => {
  await harness.close();
});

/** A client for the scripted server, once a run has registered the type. */
async function marfa(): Promise<Marfa> {
  expect(await harness.once(vendor([]))).toBe(0);
  return new Marfa(() =>
    createClient({
      baseUrl: harness.server.url,
      credential: harness.server.key,
    }),
  );
}

it("creates a row at the tier it names, and at the feed tier when it names none", async () => {
  const client = await marfa();
  const results = await client.create("test.entry", harness.server.source, [
    { source_id: "plain", properties: { title: "Plain" } },
    { source_id: "feed", properties: { title: "Feed" }, tier: "feed" },
    { source_id: "library", properties: { title: "Library" }, tier: "library" },
  ]);
  expect(results.map((result) => result.outcome)).toEqual([
    "created",
    "created",
    "created",
  ]);
  expect(
    ["plain", "feed", "library"].map((id) => harness.server.row(id).tier),
  ).toEqual(["feed", "feed", "library"]);
});

it("lists the rows of one tier, or of both when it names none", async () => {
  const client = await marfa();
  await client.create("test.entry", harness.server.source, [
    { source_id: "a", properties: { title: "A" } },
    { source_id: "b", properties: { title: "B" }, tier: "library" },
    { source_id: "c", properties: { title: "C" }, tier: "library" },
  ]);
  const ids = async (tier?: "feed" | "library" | "all"): Promise<string[]> =>
    (await client.ownRows("test.entry", "any", tier))
      .map((row) => row.source_id ?? "")
      .sort();
  expect(await ids()).toEqual(["a", "b", "c"]);
  expect(await ids("all")).toEqual(["a", "b", "c"]);
  expect(await ids("feed")).toEqual(["a"]);
  expect(await ids("library")).toEqual(["b", "c"]);
});
