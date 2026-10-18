import { afterEach, describe, expect, it } from "vitest";
import { assertSameOrigin, publicOrigin } from "./session";

afterEach(() => {
  delete process.env.MOOZ_PUBLIC_URL;
});

const req = (headers: Record<string, string> = {}, url = "http://localhost:3000/api/x") =>
  new Request(url, { method: "POST", headers });

describe("publicOrigin", () => {
  it("prefers MOOZ_PUBLIC_URL over request headers", () => {
    process.env.MOOZ_PUBLIC_URL = "https://meet.example.com/";
    expect(publicOrigin(req({ "x-forwarded-host": "evil.example" }))).toBe("https://meet.example.com");
  });

  it("falls back to forwarded headers behind a proxy", () => {
    expect(publicOrigin(req({ "x-forwarded-proto": "https", "x-forwarded-host": "meet.example.com" }))).toBe(
      "https://meet.example.com",
    );
  });
});

describe("assertSameOrigin", () => {
  it("allows requests without browser origin headers (CLI, server-to-server)", () => {
    expect(() => assertSameOrigin(req())).not.toThrow();
  });

  it("allows same-origin and user-initiated navigations", () => {
    expect(() => assertSameOrigin(req({ "sec-fetch-site": "same-origin" }))).not.toThrow();
    expect(() => assertSameOrigin(req({ "sec-fetch-site": "none" }))).not.toThrow();
    expect(() => assertSameOrigin(req({ origin: "http://localhost:3000" }))).not.toThrow();
  });

  it("rejects sibling-site and cross-site requests", () => {
    expect(() => assertSameOrigin(req({ "sec-fetch-site": "same-site" }))).toThrow();
    expect(() => assertSameOrigin(req({ origin: "http://localhost:4000" }))).toThrow();
  });
});
