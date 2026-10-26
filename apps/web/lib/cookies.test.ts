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

  it("leaves Secure off for someone on the server's own machine over plain http, whatever the public address", () => {
    try {
      process.env.MOOZ_PUBLIC_URL = "https://quiet-river.trycloudflare.com"; // a laptop's tunnel
      for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "LOCALHOST:3000", "localhost"]) {
        expect(isHttps(new Request(`http://${host}/x`))).toBe(false);
      }
      // The same machine behind a TLS proxy, through the tunnel, or behind Caddy stays Secure.
      expect(isHttps(new Request("http://localhost:3000/x", { headers: { "x-forwarded-proto": "https" } }))).toBe(true);
      expect(isHttps(new Request("http://localhost:3000/x", { headers: { host: "quiet-river.trycloudflare.com" } }))).toBe(true);
      expect(isHttps(new Request("http://127.0.0.1:3000/x", { headers: { host: "meet.example.com" } }))).toBe(true);
      // A name that only starts like one isn't this machine.
      expect(isHttps(new Request("http://x/", { headers: { host: "localhost.example.com" } }))).toBe(true);
      expect(isHttps(new Request("http://x/", { headers: { host: "127.0.0.1.example.com" } }))).toBe(true);
    } finally {
      delete process.env.MOOZ_PUBLIC_URL;
    }
  });
});
