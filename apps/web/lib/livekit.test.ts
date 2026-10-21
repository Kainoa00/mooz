import { TokenVerifier } from "livekit-server-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { AGENT_TOKEN_TTL_MS, TOKEN_TTL_MS, livekitConfig, mintHumanToken } from "./livekit";
import { LK_KEY, LK_SECRET, useTestEnv } from "@/test/helpers";

beforeEach(useTestEnv);

describe("livekitConfig", () => {
  it("reads url and credentials from the environment", () => {
    expect(livekitConfig()).toEqual({
      url: "ws://livekit.test:7880",
      apiUrl: "http://livekit.test:7880",
      apiKey: LK_KEY,
      apiSecret: LK_SECRET,
    });
  });

  it("uses LIVEKIT_API_URL for server-to-server calls when set", () => {
    process.env.LIVEKIT_API_URL = "http://livekit:7880";
    try {
      expect(livekitConfig().apiUrl).toBe("http://livekit:7880");
    } finally {
      delete process.env.LIVEKIT_API_URL;
    }
  });

  it("refuses the public dev secret when LiveKit is reachable beyond localhost", () => {
    process.env.LIVEKIT_URL = "wss://meet.example.com";
    process.env.LIVEKIT_API_SECRET = "secret";
    expect(() => livekitConfig()).toThrow(/at least 32 characters/);
  });

  it("allows the dev secret on localhost", () => {
    process.env.LIVEKIT_URL = "ws://localhost:7880";
    process.env.LIVEKIT_API_SECRET = "secret";
    expect(livekitConfig().apiSecret).toBe("secret");
  });

  it("fails loudly when credentials are missing", () => {
    delete process.env.LIVEKIT_API_SECRET;
    expect(() => livekitConfig()).toThrow(/LIVEKIT_API_SECRET/);
  });
});

/** Seconds a token works (its two times come from separate clock reads, so allow a second). */
const lifetime = (claims: { exp?: number; nbf?: number }) => (claims.exp ?? 0) - (claims.nbf ?? 0);

describe("mintHumanToken", () => {
  it("grants room join for one room and marks the participant human", async () => {
    const jwt = await mintHumanToken({ room: "abc-defg-hij", identity: "p_1", name: "Zach" });

    const claims = await new TokenVerifier(LK_KEY, LK_SECRET).verify(jwt);
    expect(claims.sub).toBe("p_1");
    expect(claims.name).toBe("Zach");
    expect(claims.attributes).toEqual({ kind: "human" });
    expect(claims.video).toMatchObject({
      roomJoin: true,
      room: "abc-defg-hij",
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: false,
    });
    expect(claims.video?.roomAdmin).toBeFalsy();
    // Name checks count on how long it lasts (an hour).
    expect(lifetime(claims)).toBeGreaterThanOrEqual(TOKEN_TTL_MS / 1000 - 1);
    expect(lifetime(claims)).toBeLessThanOrEqual(TOKEN_TTL_MS / 1000);
  });

  it("carries a notes opt-out so it survives a reconnect", async () => {
    const jwt = await mintHumanToken({ room: "r", identity: "p_1", name: "Zach", notesOptOut: true });

    const claims = await new TokenVerifier(LK_KEY, LK_SECRET).verify(jwt);
    expect(claims.attributes).toEqual({ kind: "human", notes_opt_out: "1" });
  });
});

describe("mintAgentToken", () => {
  it("lets an agent join one room with audio and data only, labelled with its owner", async () => {
    const { mintAgentToken } = await import("./livekit");
    const jwt = await mintAgentToken({
      identity: "a_1",
      slug: "abc-defg-hij",
      livekitRoom: "lk_internal",
      name: "Grok",
      ownerIdentity: "p_9",
      ownerName: "Zach",
    });

    const claims = await new TokenVerifier(LK_KEY, LK_SECRET).verify(jwt);
    expect(lifetime(claims)).toBeGreaterThanOrEqual(AGENT_TOKEN_TTL_MS / 1000 - 1);
    expect(lifetime(claims)).toBeLessThanOrEqual(AGENT_TOKEN_TTL_MS / 1000);
    expect(claims.sub).toBe("a_1");
    expect(claims.name).toBe("Grok");
    expect(claims.attributes).toEqual({
      kind: "agent",
      door: "bridge",
      owner_id: "p_9",
      owner_name: "Zach",
    });
    expect(claims.video).toMatchObject({
      roomJoin: true,
      room: "lk_internal",
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: false,
      canPublishSources: ["microphone"],
    });
    expect(claims.video?.roomAdmin).toBeFalsy();
  });
});
