import { describe, expect, it } from "vitest";
import { hashSecret, newId, newRoomSlug, newSecret } from "./ids";

describe("newRoomSlug", () => {
  it("produces a readable xxx-xxxx-xxx slug", () => {
    expect(newRoomSlug()).toMatch(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  });

  it("does not repeat across many draws", () => {
    const slugs = new Set(Array.from({ length: 500 }, newRoomSlug));
    expect(slugs.size).toBe(500);
  });
});

describe("newSecret", () => {
  it("is url-safe and long enough to be unguessable", () => {
    const s = newSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("newId", () => {
  it("prefixes the id", () => {
    expect(newId("p")).toMatch(/^p_[a-z0-9]{16}$/);
  });
});

describe("hashSecret", () => {
  it("is deterministic and does not return the secret", () => {
    expect(hashSecret("abc")).toBe(hashSecret("abc"));
    expect(hashSecret("abc")).not.toContain("abc");
    expect(hashSecret("abc")).not.toBe(hashSecret("abd"));
  });
});
