import { describe, expect, it } from "vitest";
import { readCookie } from "./cookies";

describe("readCookie", () => {
  const req = (cookie?: string) =>
    new Request("http://x", { headers: cookie ? { cookie } : {} });

  it("finds a cookie among several", () => {
    expect(readCookie(req("a=1; mooz_p_x=abc%3D; b=2"), "mooz_p_x")).toBe("abc=");
  });

  it("returns undefined when absent", () => {
    expect(readCookie(req("a=1"), "b")).toBeUndefined();
    expect(readCookie(req(), "b")).toBeUndefined();
  });
});
