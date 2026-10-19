import { describe, expect, it } from "vitest";
import { ownedName } from "./labels";
import { NOTES_QUERY, notesAllowed, notesBannerText, parseNotesAnnouncement } from "./notes-protocol";

const encode = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

describe("notes protocol", () => {
  it("reads the host's policy from room metadata, off unless clearly on", () => {
    expect(notesAllowed('{"notes_allowed":true}')).toBe(true);
    expect(notesAllowed('{"notes_allowed":false}')).toBe(false);
    expect(notesAllowed('{"notes_allowed":"true"}')).toBe(false);
    expect(notesAllowed("not json")).toBe(false);
    expect(notesAllowed("")).toBe(false);
    expect(notesAllowed(undefined)).toBe(false);
  });

  it("parses agents' notes announcements and ignores anything else", () => {
    expect(parseNotesAnnouncement(encode({ type: "notes", state: "on" }))).toBe("on");
    expect(parseNotesAnnouncement(encode({ type: "notes", state: "off" }))).toBe("off");
    expect(parseNotesAnnouncement(encode({ type: "notes", state: "maybe" }))).toBeNull();
    expect(parseNotesAnnouncement(encode({ type: "other", state: "on" }))).toBeNull();
    expect(parseNotesAnnouncement(encode("{nope"))).toBeNull();
    expect(parseNotesAnnouncement(encode([1, 2]))).toBeNull();
  });

  it("asks agents with a small query message", () => {
    expect(JSON.parse(new TextDecoder().decode(NOTES_QUERY))).toEqual({ type: "notes?" });
    expect(parseNotesAnnouncement(NOTES_QUERY)).toBeNull();
  });

  it("names every agent keeping notes", () => {
    expect(notesBannerText(["Kainoa's Atlas"])).toBe("📝 Kainoa's Atlas is keeping notes");
    expect(notesBannerText(["Kainoa's Atlas", "Zach's Grok"])).toBe(
      "📝 Kainoa's Atlas and Zach's Grok are keeping notes",
    );
    expect(notesBannerText(["A", "B", "C"])).toBe("📝 A, B and C are keeping notes");
    expect(notesBannerText([], ["Kainoa's Grok"])).toBe(
      "📝 Kainoa's Grok can share what's said with its assistant app when asked",
    );
    expect(notesBannerText(["Zach's Atlas"], ["Kainoa's Grok", "Lee's Claude"])).toBe(
      "📝 Zach's Atlas is keeping notes; Kainoa's Grok and Lee's Claude can share what's said with their assistant apps when asked",
    );
  });

  it("names an agent by its owner", () => {
    expect(ownedName({ name: "Atlas", attributes: { kind: "agent", owner_name: "Kainoa" } })).toBe("Kainoa's Atlas");
    expect(ownedName({ name: "Atlas", attributes: { kind: "agent" } })).toBe("Atlas");
  });
});
