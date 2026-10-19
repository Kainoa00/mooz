import { afterEach, describe, expect, it } from "vitest";
import { envInt } from "./env";

afterEach(() => {
  delete process.env.MOOZ_TEST_LIMIT;
});

describe("envInt", () => {
  it("reads a positive whole number, and falls back on anything else", () => {
    expect(envInt("MOOZ_TEST_LIMIT", 60)).toBe(60);
    process.env.MOOZ_TEST_LIMIT = "250";
    expect(envInt("MOOZ_TEST_LIMIT", 60)).toBe(250);
    for (const bad of ["0", "-5", "1.5", "lots", ""]) {
      process.env.MOOZ_TEST_LIMIT = bad;
      expect(envInt("MOOZ_TEST_LIMIT", 60)).toBe(60);
    }
  });
});
