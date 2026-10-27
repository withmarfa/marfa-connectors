import { describe, expect, it } from "vitest";
import {
  guardedLookup,
  guardHost,
  privateHostSet,
  RefusedAddress,
} from "../src/network.js";

describe("guardHost", () => {
  it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "fd00::1"])(
    "refuses the address %s, naming the hop",
    (address) => {
      expect(() => guardHost(address, false, 3)).toThrow(RefusedAddress);
      try {
        guardHost(address, false, 3);
      } catch (error) {
        expect((error as RefusedAddress).hop).toBe(3);
      }
    },
  );

  it("lets an allowed host through unguarded, and a public literal with no lookup", () => {
    expect(guardHost("127.0.0.1", true, 0)).toBeUndefined();
    expect(guardHost("localhost", true, 0)).toBeUndefined();
    expect(guardHost("93.184.216.34", false, 0)).toBeUndefined();
  });

  it("guards the lookup of a name", () => {
    expect(guardHost("pictures.example", false, 0)).toBe(guardedLookup);
  });
});

describe("guardedLookup", () => {
  it("refuses a name that resolves to this machine", async () => {
    const error = await new Promise<unknown>((done) => {
      guardedLookup("localhost", {}, (failure) => {
        done(failure);
      });
    });
    expect(error).toBeInstanceOf(RefusedAddress);
  });
});

describe("privateHostSet", () => {
  it("reads hosts as a URL reads them", () => {
    expect([
      ...privateHostSet(" LOCALHOST.  bücher.example\n[::1] 10.0.0.2 ", "X"),
    ]).toEqual(["localhost", "xn--bcher-kva.example", "::1", "10.0.0.2"]);
    expect(privateHostSet(undefined, "X").size).toBe(0);
  });

  it.each(["host:8080", "host/path", "user@host", "host?q", "host#h"])(
    "refuses %s, naming the setting",
    (entry) => {
      expect(() => privateHostSet(entry, "SOME_HOSTS")).toThrow(
        "SOME_HOSTS holds an entry that is not a host name",
      );
    },
  );
});
