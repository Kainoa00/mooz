import { describe, expect, it } from "vitest";
import { errorMessage, readBody } from "./fetch-json";

describe("readBody", () => {
  it("parses JSON objects", async () => {
    expect(await readBody(Response.json({ a: 1 }))).toEqual({ a: 1 });
  });

  it("returns null for an HTML error page instead of throwing", async () => {
    expect(await readBody(new Response("<h1>502 Bad Gateway</h1>", { status: 502 }))).toBeNull();
  });
});

describe("errorMessage", () => {
  it("uses the server's message when present", () => {
    expect(errorMessage({ error: { code: "x", message: "No such meeting" } }, "fallback")).toBe("No such meeting");
  });

  it("falls back otherwise", () => {
    expect(errorMessage(null, "Could not join")).toBe("Could not join");
    expect(errorMessage({ error: "weird" }, "Could not join")).toBe("Could not join");
  });
});
