import { describe, expect, it } from "vitest";
import { HttpError, errorResponse, readJson } from "./http";

describe("errorResponse", () => {
  it("renders an HttpError with its status and code", async () => {
    const res = errorResponse(new HttpError(404, "room_not_found", "No such room"));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "room_not_found", message: "No such room" },
    });
  });

  it("hides unexpected errors behind a generic 500", async () => {
    const res = errorResponse(new Error("database exploded"));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "internal", message: "Something went wrong" },
    });
  });
});

describe("readJson", () => {
  it("parses a JSON object body", async () => {
    const req = new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) });

    expect(await readJson(req)).toEqual({ a: 1 });
  });

  it("rejects malformed JSON with a 400", async () => {
    const req = new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: "{nope" });

    await expect(readJson(req)).rejects.toMatchObject({ status: 400, code: "invalid_json" });
  });

  it("rejects non-object JSON with a 400", async () => {
    const req = new Request("http://x", { method: "POST", headers: { "content-type": "application/json" }, body: "[1,2]" });

    await expect(readJson(req)).rejects.toMatchObject({ status: 400, code: "invalid_json" });
  });

  it("refuses bodies that are not declared as JSON (blocks text/plain form CSRF)", async () => {
    const req = new Request("http://x", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ decision: "approve" }),
    });

    await expect(readJson(req)).rejects.toMatchObject({ status: 415 });
  });
});
