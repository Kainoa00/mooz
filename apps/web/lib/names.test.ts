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
    ["ΗΑΝΚ", "Hank"], // Greek capitals by their own shape: Ν is N, though ν is v
    ["ΡΕΝΝΥ", "Penny"],
    ["ꓮꓔꓡꓮꓢ", "Atlas"], // Lisu
    ["Веӏӏа", "Bella"], // Cyrillic palochka
    ["ВЕӀӀА", "Bella"],
    ["һоӏӏу", "Holly"],
    ["һех", "Hex"],
    ["AtIas", "Atlas"], // a capital I for l
    ["KaI", "Kal"],
    ["AtIis", "Atlas"], // which reads Atlis, and sounds like it
    ["lris", "Iris"], // and an l for I
    ["Atlas", "AtIas"], // the agent's name read as it looks, too
    ["At1as", "Atlas"],
    ["Atǀas", "Atlas"], // a click letter, drawn as a bar
    ["Atƚas", "Atlas"],
    ["ꜰelix", "Felix"], // a small capital
    ["Ꜳtlas", "Atlas"], // Latin letters no table knows, where the rest is the agent's name
    ["Atʻlas", "Atlas"], // an ʻokina, as an apostrophe would be
    ["At’las", "Atlas"], // the curly apostrophe phones type
    ["At´las", "Atlas"],
    ["ARlA", "ARIA"], // an l among capitals reads as I
    ["JARVlS", "JARVIS"],
    ["KAl", "KAI"],
    ["NovaAl", "NovaAI"],
    ["lola", "Iola"], // and an l that starts a word
    ["lsabel", "Isabelle"], // said as the I it looks like, where an l can't be said
    ["lriss", "Iris"],
    ["lrys", "Iris"],
    ["lliya", "Ilya"],
    ["lggor", "Igor"],
    ["Maria lsabel", "Isabelle"],
    ["Əli", "Ali"], // ə is said like a
    ["Həsən", "Hasan"],
    ["Kəmalə", "Kamala"],
    ["ɳoʋa", "Nova"], // more Latin letters drawn like plain ones
    ["ɠrɔk", "Grok"],
    ["Atˊlas", "Atlas"], // more marks drawn like an apostrophe
    ["Atˋlas", "Atlas"],
    ["At‛las", "Atlas"],
    ["At\u1ffdlas", "Atlas"],
    ["At\u0384las", "Atlas"],
    ["At‵las", "Atlas"],
    ["At᾽las", "Atlas"], // Greek koronis, psili and dasia, the Armenian apostrophe, the Hebrew geresh
    ["At᾿las", "Atlas"],
    ["At῾las", "Atlas"],
    ["At՚las", "Atlas"],
    ["At׳las", "Atlas"],
    ["lśabel", "Isabelle"], // an accented consonant is still one
  ])("refuses %j while %j is here, and the agent while they are", (name, agent) => {
    expect(() => parseDisplayName(name, [agent])).toThrowError(expect.objectContaining({ status: 409, code: "name_taken" }));
    expect(() => parseAgentName(agent, [name])).toThrowError(expect.objectContaining({ status: 409, code: "name_taken" }));
  });

  it.each([
    ["Joel", "Joe"], // an l inside a word is an l
    ["Phil", "Phi"],
    ["Salim", "Sam"],
    ["Mila", "Mia"],
    ["Kal", "Kai"],
    ["Ira", "Lyra"], // and a capital I that starts one is an I
    ["Ilham", "Llama"],
    ["Ian", "Lan"],
    ["Clara", "Kiara"], // an l before a small letter is an l, after a capital too
    ["Alan", "Aian"],
    ["lily", "Ilya"], // an l read as I matches only by spelling, not by sound
    ["lila", "Ila"],
    ["leila", "Ila"],
    ["lyla", "Iola"],
    ["lisa", "Isa"],
    ["lena", "Iona"],
    ["Ƙasim", "Wasim"], // Latin letters the tables know read as themselves
    ["Ɲama", "Rama"],
    ["Ɗan", "Ian"],
    ["Ɓala", "Nala"],
    ["Ɓello", "Jello"],
    ["Əli", "Oli"],
    ["Ɓɔla", "Lila"], // ɓ reads as b
    ["Ɛɛna", "Lena"], // and unknown letters stand in only for fewer than half the letters
    ["lara", "Ira"], // an l before a vowel is said as one
    ["lana", "Ian"],
    ["luna", "Ina"],
    ["leon", "Ion"],
    ["léon", "Ion"], // a vowel with an accent is still a vowel
    ["léon".normalize("NFD"), "Ion"],
    ["léna", "Ina"],
    ["lúna", "Ina"],
    ["lúna".normalize("NFD"), "Ina"],
    ["lívia", "Iva"],
    ["lāna", "Ian"],
    ["Sevinc Həsənova", "Nova"], // ə doesn't split a word in two
    ["Cəlil", "Leila"],
    ["O’Brien", "Brien"], // ’ is an apostrophe, as ' is
  ])("keeps %j next to an agent called %j, either way round", (name, agent) => {
    expect(parseDisplayName(name, [agent])).toBe(name);
    expect(parseAgentName(agent, [name])).toBe(agent);
  });

  it("keeps names written in one alphabet, Latin or not", () => {
    for (const name of ["Michał", "Þóra", "Łukasz", "Søren", "Zoë", "Мария", "李华", "José García", "Ελένη"]) {
      expect(parseDisplayName(name, ["Atlas"])).toBe(name);
    }
    // Letters no table knows stand in for others only in a word that is mostly the agent's name.
    expect(parseDisplayName("さくら", ["Kai"])).toBe("さくら");
    expect(parseDisplayName("Ɔdɛ", ["Ode"])).toBe("Ɔdɛ");
  });

  it.each([
    "İlham Əliyev", // Azerbaijani
    "Cəlil Məmmədov",
    "Oʻktam Rahimov", // Uzbek
    "Hawaiʻi Lani", // the ʻokina
    "Tāufaʻāhau Tupou",
    "Mʼbaye",
    "Kofi Ɔdɛɛ", // Akan
    "Ɗanjuma Ƙasim", // Hausa
    "Ngozi Ɓello",
    "Ɲaré Kouyaté", // Bambara
    "ǃXóõ",
  ])("keeps Latin letters beyond a to z: %j", (name) => {
    expect(parseDisplayName(name, ["Atlas"])).toBe(name);
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
