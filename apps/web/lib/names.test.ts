import { describe, expect, it } from "vitest";
import { foldName, parseAgentName, parseDisplayName } from "./names";

describe("parseDisplayName", () => {
  it("collapses whitespace", () => {
    expect(parseDisplayName("  Kainoa   K  ")).toBe("Kainoa K");
  });


  it.each(["Mehr\u200Cdad", "Kai \u{1F469}\u200D\u{1F4BB}"])("keeps joiners real names need: %j", (name) => {
    expect(parseDisplayName(name)).toBe(name);
  });

  it.each(["Ka\u200Binoa", "\u202Eanioak", "\u2066Kai\u2069"])("rejects invisible or bidi tricks: %j", (name) => {
    expect(() => parseDisplayName(name)).toThrowError(expect.objectContaining({ code: "invalid_name" }));
  });
});

describe("parseAgentName", () => {
  it("accepts a distinct name and trims it", () => {
    expect(parseAgentName("  Atlas ", [])).toBe("Atlas");
  });

  it.each(["Zach's Grok", "Nova Prime", "Max"])("accepts %j", (name) => {
    expect(parseAgentName(name, [])).toBe(name);
  });

  it.each([
    ["mooz", "reserved_name"],
    ["Mooz", "reserved_name"],
    ["everyone", "reserved_name"],
    ["Agents", "reserved_name"],
    ["hey", "reserved_name"],
    ["okay", "reserved_name"],
    ["A", "invalid_agent_name"],
    ["Al", "invalid_agent_name"],
    ["Nova 2", "invalid_agent_name"], // would wake on a bare "2"
    ["R2-D2", "invalid_agent_name"],
    ["Notes", "reserved_name"], // a word people say all the time
    ["Zach's Notes", "reserved_name"],
    ["Mark", "reserved_name"],
    ["x".repeat(25), "invalid_agent_name"],
    ["2pac", "invalid_agent_name"],
    ["<script>", "invalid_agent_name"],
    ["", "invalid_agent_name"],
  ])("rejects %j with %s", (name, code) => {
    expect(() => parseAgentName(name, [])).toThrowError(expect.objectContaining({ status: 400, code }));
  });

  it("rejects a non-string", () => {
    expect(() => parseAgentName(7, [])).toThrowError(expect.objectContaining({ code: "invalid_agent_name" }));
  });

  it("rejects names already taken in the meeting, ignoring case", () => {
    expect(() => parseAgentName("atlas", ["Atlas"])).toThrowError(
      expect.objectContaining({ status: 409, code: "name_taken" }),
    );
  });

  it("rejects an agent named after a person in the meeting", () => {
    expect(() => parseAgentName("Zach", ["Kainoa", "zach"])).toThrowError(
      expect.objectContaining({ code: "name_taken" }),
    );
  });

  it.each([
    ["Atlis", "Atlas"], // sounds alike
    ["Atlass", "Atlas"], // spelled alike
    ["Zack", "Zach"], // a person
    ["Zack", "Kainoa Zach"], // any word of a person's name
    ["Lee's Grok", "Grok"], // its wake word is "Grok"
    ["Grok", "Zach's Grok"], // so is the other's
  ])("rejects %j next to %j: the wrong one would answer", (name, taken) => {
    expect(() => parseAgentName(name, [taken])).toThrowError(
      expect.objectContaining({ status: 409, code: "name_taken", message: expect.stringContaining("sounds too much like") }),
    );
  });

  it("doesn't say whose name it clashes with: the asker may not see everyone who counts", () => {
    expect(() => parseAgentName("Zack", ["Kainoa Zach"])).toThrowError(
      expect.objectContaining({ message: expect.not.stringContaining("Kainoa") }),
    );
  });

  it.each([
    ["Grok Prime", "Grok"], // saying "Grok Prime" would wake Grok too
    ["Nova Atlas", "Zach's Atlas"],
  ])("rejects %j next to the agent %j, whose wake word it holds", (name, agent) => {
    expect(() => parseAgentName(name, [], [agent])).toThrowError(expect.objectContaining({ status: 409, code: "name_taken" }));
  });

  it("lets an agent hold a person's name as a word that isn't its wake word: people don't wake", () => {
    expect(parseAgentName("Grok Prime", ["Grok"], [])).toBe("Grok Prime");
  });

  it.each([
    ["Zach's Grok", "Zach"], // its owner: "Zach" alone doesn't wake "Zach's Grok"
    ["Nova", "Atlas"],
    ["Atlas", "Alice"],
  ])("accepts %j next to %j", (name, taken) => {
    expect(parseAgentName(name, [taken])).toBe(name);
  });
});

describe("people's names next to agents", () => {
  it.each([
    ["Atlis", "Atlas"],
    ["Grok Smith", "Zach's Grok"],
    ["grok", "Grok"],
    ["Ａｔｌａｓ", "Atlas"], // fullwidth
    ["Аtlas", "Atlas"], // a Cyrillic А
    ["Атлас", "Atlas"], // Atlas, in Cyrillic
    ["Nóva", "Nova"],
  ])("refuses %j while %j is here", (name, agent) => {
    expect(() => parseDisplayName(name, [agent])).toThrowError(
      expect.objectContaining({ status: 409, code: "name_taken", message: expect.stringContaining("an agent") }),
    );
  });

  it("folds names to how they sound in plain Latin letters", () => {
    expect(foldName("Ｚｏë Ελένη Мария")).toBe("zoe eleni mariya");
  });

  it("allows names in other scripts that sound different", () => {
    expect(parseDisplayName("Мария", ["Atlas"])).toBe("Мария");
    expect(parseDisplayName("José", ["Atlas"])).toBe("José");
  });

  it("allows a person whose name only shares a word with a multi-word agent's other words", () => {
    expect(parseDisplayName("Zach", ["Zach's Grok"])).toBe("Zach");
  });
});

describe("hidden text in names", () => {
  it("refuses Unicode tags, private use and smuggling selectors, but not emoji or joiners", () => {
    for (const hidden of [
      "Zach" + String.fromCodePoint(0xe0068, 0xe0069),
      "Zach\ue000",
      "Zach\u00ad",
      "Zach\ufe00",
      "Zach" + String.fromCodePoint(0xe0100),
      "Zach\u206a",
      "\u0600Zach",
      "Zach\u200d\u200d\u200d",
    ]) {
      expect(() => parseDisplayName(hidden)).toThrow("invisible");
    }
    expect(parseDisplayName("Zach ❤️")).toBe("Zach ❤️");
    expect(parseDisplayName("Zoë 🏳️‍🌈")).toBe("Zoë 🏳️‍🌈");
    expect(parseDisplayName("Kai ❤️‍🔥 🏳️‍⚧️")).toBe("Kai ❤️‍🔥 🏳️‍⚧️");
    expect(parseDisplayName("👩\u200d💻 Lee")).toBe("👩\u200d💻 Lee");
  });
});

describe("names that look like an agent's", () => {
  it.each([
    ["Сora", "Cora"], // Cyrillic С sounds like S but looks like C
    ["Рablo", "Pablo"],
    ["Нugo", "Hugo"],
    ["Вella", "Bella"],
    ["Хena", "Xena"],
    ["Maсy", "Macy"],
    ["Ρablo", "Pablo"], // Greek
    ["Ηugo", "Hugo"],
    ["At‍las", "Atlas"], // a joiner inside the word
    ["Atlaѕ", "Atlas"],
    ["Grօk", "Grok"], // Armenian o
    ["Atłas", "Atlas"],
    ["Nøva", "Nova"],
    ["ᴀtlas", "Atlas"],
    ["Grᴏk", "Grok"],
    ["ɢrok", "Grok"],
    ["ɑtlas", "Atlas"],
    ["Ꭺtlas", "Atlas"], // Cherokee
    ["ᎪᎢᏞᎪᏚ", "Atlas"],
    ["Straß", "Strass"],
  ])("refuses %j while %j is here, and the agent while they are", (name, agent) => {
    expect(() => parseDisplayName(name, [agent])).toThrowError(expect.objectContaining({ status: 409, code: "name_taken" }));
    expect(() => parseAgentName(agent, [name])).toThrowError(expect.objectContaining({ status: 409, code: "name_taken" }));
  });

  it("keeps names written in one alphabet, Latin or not", () => {
    for (const name of ["Michał", "Þóra", "Łukasz", "Søren", "Zoë", "Мария", "李华", "José García", "Ελένη"]) {
      expect(parseDisplayName(name, ["Atlas"])).toBe(name);
    }
  });

  it("refuses a word that mixes alphabets, which could look like a name it doesn't match", () => {
    expect(() => parseDisplayName("Grօk")).toThrowError(expect.objectContaining({ status: 400, code: "invalid_name" }));
    expect(() => parseDisplayName("Kaiнoa")).toThrowError(expect.objectContaining({ status: 400 }));
  });
});

describe("an agent's wake word", () => {
  it.each(["Unit 123", "Agent 007", "Zach's 999", "R2D2"])("needs 3 letters, not just numbers: %j", (name) => {
    expect(() => parseAgentName(name, [])).toThrowError(expect.objectContaining({ status: 400, code: "invalid_agent_name" }));
  });

  it("may have numbers with its letters", () => {
    expect(parseAgentName("Nova3000", [])).toBe("Nova3000");
  });
});
