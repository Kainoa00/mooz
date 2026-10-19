import { describe, expect, it } from "vitest";
import { isHttps, readCookie } from "./cookies";

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

describe("isHttps", () => {
  it("trusts the configured public address over what a proxy forgot to say", () => {
    const plain = new Request("http://internal:3000/x");
    try {
      process.env.MOOZ_PUBLIC_URL = "https://meet.example.com";
      expect(isHttps(plain)).toBe(true);
      process.env.MOOZ_PUBLIC_URL = "not a url";
      expect(isHttps(plain)).toBe(false);
    } finally {
      delete process.env.MOOZ_PUBLIC_URL;
    }
    expect(isHttps(new Request("http://x/", { headers: { "x-forwarded-proto": "https" } }))).toBe(true);
  });
});
