import { describe, expect, it } from "vitest";
import { decodeLegacyChat } from "./chat-decode";

const packet = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

describe("decodeLegacyChat", () => {
  it("passes a well-formed message, keeping only text attributes", () => {
    expect(decodeLegacyChat(packet({ id: "m1", message: "hi", timestamp: 5, attributes: { a: "1", b: 2 } }))).toEqual({
      id: "m1",
      message: "hi",
      timestamp: 5,
      attributes: { a: "1" },
    });
  });

  it.each([
    ["not JSON", "{oops"],
    ["null", "null"],
    ["an object for its id", { id: { toString: 1 }, message: "hi", timestamp: 1 }],
    ["an object for its text", { id: "m1", message: { a: 1 }, timestamp: 1 }],
    ["no time", { id: "m1", message: "hi" }],
    ["a time that isn't one", { id: "m1", message: "hi", timestamp: "soon" }],
    ["the echo of a message also sent as a text stream", { id: "m1", message: "hi", timestamp: 1, ignoreLegacy: true }],
  ])("ignores %s", (_what, value) => {
    expect(decodeLegacyChat(packet(value))).toBeNull();
  });
});
