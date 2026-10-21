import { describe, expect, it } from "vitest";
import { checkConfig } from "./config-check";

const STRONG = "x".repeat(40);
const deployed = {
  LIVEKIT_URL: "wss://livekit.example.com",
  LIVEKIT_API_KEY: "mooz",
  LIVEKIT_API_SECRET: STRONG,
  MOOZ_PUBLIC_URL: "https://meet.example.com",
};

describe("checkConfig", () => {
  it("passes the guide's settings and the local dev ones", () => {
    expect(checkConfig(deployed)).toEqual([]);
    expect(checkConfig({ LIVEKIT_URL: "ws://localhost:7880", LIVEKIT_API_KEY: "devkey", LIVEKIT_API_SECRET: "secret" })).toEqual([]);
    expect(checkConfig({ ...deployed, MOOZ_PUBLIC_URL: "http://localhost:3000", LIVEKIT_URL: "ws://localhost:7880" })).toEqual([]);
  });

  it("needs LiveKit's address and keys", () => {
    expect(checkConfig({})).toHaveLength(3);
    expect(checkConfig({ ...deployed, LIVEKIT_URL: "https://livekit.example.com" })).toEqual([
      expect.stringContaining("ws:// or wss://"),
    ]);
  });

  it.each([
    [{ LIVEKIT_API_SECRET: "secret" }, /32 characters/],
    [{ LIVEKIT_API_SECRET: "short-but-random" }, /32 characters/],
    [{ LIVEKIT_API_KEY: "devkey" }, /public dev key/],
    [{ LIVEKIT_URL: "ws://livekit.example.com" }, /must be wss/],
    [{ MOOZ_PUBLIC_URL: undefined }, /Set MOOZ_PUBLIC_URL/],
    [{ MOOZ_PUBLIC_URL: "http://meet.example.com" }, /must be https/],
    [{ MOOZ_PUBLIC_URL: "https://meet.example.com/mooz" }, /no path/],
    [{ MOOZ_PUBLIC_URL: "not a url" }, /the address people open/],
  ])("refuses %j off this machine", (change, problem) => {
    expect(checkConfig({ ...deployed, ...change }).join("\n")).toMatch(problem);
  });
});
