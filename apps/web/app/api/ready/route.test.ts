import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTestEnv } from "@/test/helpers";
import { GET } from "./route";

beforeEach(() => {
  useTestEnv();
  process.env.LIVEKIT_URL = "wss://livekit.example.com";
  process.env.MOOZ_PUBLIC_URL = "https://meet.example.com";
});
afterEach(() => {
  delete process.env.MOOZ_PUBLIC_URL;
});
afterEach(() => vi.restoreAllMocks());

describe("GET /api/ready", () => {
  it("is ready with good settings and a database", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("says no, with the details only in the logs", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.LIVEKIT_API_SECRET = "secret";
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ ok: false });
    expect(body).not.toContain("SECRET");
    expect(String(logged.mock.calls[0][0])).toMatch(/LIVEKIT_API_SECRET must be a random secret/);
  });
});
