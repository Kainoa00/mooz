import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, livekitOrigins, newNonce } from "./csp";

function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split("; ").map((d) => {
      const [name, ...values] = d.split(" ");
      return [name, values];
    }),
  );
}

describe("livekitOrigins", () => {
  it("allows LiveKit's socket and its HTTP twin, and nothing for anything else", () => {
    expect(livekitOrigins("ws://localhost:7880")).toEqual(["ws://localhost:7880", "http://localhost:7880"]);
    expect(livekitOrigins("wss://lk.example.com/some/path?x=1")).toEqual(["wss://lk.example.com", "https://lk.example.com"]);
    expect(livekitOrigins(undefined)).toEqual([]);
    expect(livekitOrigins("not a url")).toEqual([]);
    expect(livekitOrigins("https://lk.example.com")).toEqual([]);
    expect(livekitOrigins("wss://lk.example.com; script-src *")).toEqual([]);
    expect(livekitOrigins("wss://lk.example.com;script-src")).toEqual([]);
    expect(livekitOrigins("ws://[::1]:7880")).toEqual(["ws://[::1]:7880", "http://[::1]:7880"]);
  });
});

describe("contentSecurityPolicy", () => {
  it("runs only this request's scripts and connects only where the meeting needs", () => {
    const d = directives(contentSecurityPolicy({ nonce: "abc123", livekitUrl: "wss://lk.example.com" }));
    expect(d["script-src"]).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"]);
    expect(d["connect-src"]).toEqual([
      "'self'",
      "wss://lk.example.com",
      "https://lk.example.com",
      "https://api.elevenlabs.io",
      "wss://api.elevenlabs.io",
    ]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'none'"]);
    expect(d["connect-src"]).not.toContain("wss:");
  });

  it("lets React's dev tooling eval in development only", () => {
    expect(directives(contentSecurityPolicy({ nonce: "n", dev: true }))["script-src"]).toContain("'unsafe-eval'");
    expect(directives(contentSecurityPolicy({ nonce: "n" }))["script-src"]).not.toContain("'unsafe-eval'");
  });
});

describe("newNonce", () => {
  it("is fresh each time and safe inside a policy", () => {
    const a = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(newNonce()).not.toBe(a);
  });
});
