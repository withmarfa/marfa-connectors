import { describe, expect, it } from "vitest";
import {
  exactDependency,
  sameClient,
  type ClientIdentity,
} from "../check-image-client.js";

const installed: ClientIdentity = {
  version: "0.0.3",
  contract: 0,
  runtime: "registry-runtime-sha256",
  types: "registry-types-sha256",
};

describe("deployed registry client identity", () => {
  it("accepts exactly the installed version, contract and bytes", () => {
    expect(sameClient({ ...installed }, installed)).toBe(true);
  });
  it.each<[keyof ClientIdentity, string | number]>([
    ["version", "0.0.2"],
    ["contract", 3],
    ["runtime", "different-runtime"],
    ["types", "different-types"],
  ])("rejects different %s", (field, value) => {
    expect(sameClient({ ...installed, [field]: value }, installed)).toBe(false);
  });
  it("requires an exact consumer dependency matching the installed package", () => {
    expect(() => {
      exactDependency("0.0.3", installed.version);
    }).not.toThrow();
    for (const specifier of [
      "*",
      "^0.0.3",
      "file:vendor/client.tar",
      "0.0.2",
    ]) {
      expect(() => {
        exactDependency(specifier, installed.version);
      }).toThrow();
    }
  });
});
