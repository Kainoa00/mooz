import { beforeEach, describe, expect, it, vi } from "vitest";

// Counts how often a name's words are worked out, to show each is worked out once.
const counted = vi.hoisted(() => ({ nameWords: 0 }));
vi.mock("./addressing", async (importOriginal) => {
  const real = await importOriginal<typeof import("./addressing")>();
  return {
    ...real,
    nameWords: (name: string) => {
      counted.nameWords++;
      return real.nameWords(name);
    },
  };
});

const { forgetNames, namesInMemoryForTests, parseAgentName, parseDisplayName } = await import("./names");

beforeEach(() => {
  forgetNames();
  counted.nameWords = 0;
});

describe("the names worked out for name checks", () => {
  it("are worked out once each, and again only after they're forgotten", () => {
    const people = Array.from({ length: 50 }, (_, i) => `Guest ${i}`);
    parseAgentName("Atlas", people);
    expect(counted.nameWords).toBeGreaterThan(0);
    const first = counted.nameWords;
    counted.nameWords = 0;
    parseAgentName("Atlas", people);
    expect(counted.nameWords).toBeLessThan(first / 10); // only the name being checked
    forgetNames();
    counted.nameWords = 0;
    parseAgentName("Atlas", people);
    expect(counted.nameWords).toBe(first);
  });

  it("keep only names the server accepted, never the one being checked", () => {
    for (let i = 0; i < 100; i++) expect(() => parseDisplayName(`Atlas`, ["Atlas"])).toThrow();
    for (let i = 0; i < 100; i++) parseDisplayName(`Guest ${i}`, ["Atlas"]);
    expect(namesInMemoryForTests()).toBe(1); // the agent's
  });
});
