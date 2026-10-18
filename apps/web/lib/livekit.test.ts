import { TokenVerifier } from "livekit-server-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { livekitConfig, mintHumanToken } from "./livekit";
import { LK_KEY, LK_SECRET, useTestEnv } from "@/test/helpers";

beforeEach(useTestEnv);

describe("livekitConfig", () => {
  it("reads url and credentials from the environment", () => {
    expect(livekitConfig()).toEqual({
      url: "ws://livekit.test:7880",
      apiKey: LK_KEY,
      apiSecret: LK_SECRET,
    });
  });

  it("fails loudly when credentials are missing", () => {
    delete process.env.LIVEKIT_API_SECRET;
    expect(() => livekitConfig()).toThrow(/LIVEKIT_API_SECRET/);
  });
});

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
  });
});

describe("mintAgentToken", () => {
  it("lets an agent join one room with audio and data only, labelled with its owner", async () => {
    const { mintAgentToken } = await import("./livekit");
    const jwt = await mintAgentToken({
      identity: "a_1",
      slug: "abc-defg-hij",
      name: "Grok",
      ownerIdentity: "p_9",
      ownerName: "Zach",
    });

    const claims = await new TokenVerifier(LK_KEY, LK_SECRET).verify(jwt);
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
      room: "abc-defg-hij",
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: false,
      canPublishSources: ["microphone"],
    });
    expect(claims.video?.roomAdmin).toBeFalsy();
  });
});
