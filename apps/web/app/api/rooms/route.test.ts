import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { getRoom, isHost } from "@/lib/rooms";
import { setCookies, useTestEnv } from "@/test/helpers";
import { POST } from "./route";

beforeEach(useTestEnv);

describe("POST /api/rooms", () => {
  it("creates a room and sets an HTTP-only host cookie", async () => {
    const res = await POST(new Request("http://localhost:3000/api/rooms", { method: "POST" }));

    expect(res.status).toBe(201);
    const { slug } = (await res.json()) as { slug: string };
    expect(getRoom(getDb(), slug)).toBeDefined();

    const cookies = setCookies(res);
    expect(isHost(getDb(), slug, cookies[`mooz_host_${slug}`])).toBe(true);

    const line = res.headers.getSetCookie()[0];
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=Lax/i);
    expect(line).not.toMatch(/Secure/i);
  });

  it("marks the cookie Secure behind HTTPS", async () => {
    const res = await POST(
      new Request("http://internal:3000/api/rooms", {
        method: "POST",
        headers: { "x-forwarded-proto": "https" },
      }),
    );

    expect(res.headers.getSetCookie()[0]).toMatch(/Secure/);
  });

  it("leaves Secure off at http://localhost when the public address is a tunnel, so every browser keeps it", async () => {
    process.env.MOOZ_PUBLIC_URL = "https://quiet-river.trycloudflare.com";
    try {
      const res = await POST(new Request("http://localhost:3000/api/rooms", { method: "POST" }));
      expect(res.status).toBe(201);
      expect(res.headers.getSetCookie()[0]).not.toMatch(/Secure/i);
    } finally {
      delete process.env.MOOZ_PUBLIC_URL;
    }
  });
});
