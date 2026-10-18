import { AccessToken } from "livekit-server-sdk";

export interface LivekitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function livekitConfig(): LivekitConfig {
  return {
    url: required("LIVEKIT_URL"),
    apiKey: required("LIVEKIT_API_KEY"),
    apiSecret: required("LIVEKIT_API_SECRET"),
  };
}

const TOKEN_TTL = "1h";

/**
 * A join token for a human participant. Participants cannot edit their own
 * attributes, so nobody can relabel themselves as an agent (or vice versa).
 */
export async function mintHumanToken(input: {
  room: string;
  identity: string;
  name: string;
}): Promise<string> {
  const { apiKey, apiSecret } = livekitConfig();
  const at = new AccessToken(apiKey, apiSecret, {
    identity: input.identity,
    name: input.name,
    ttl: TOKEN_TTL,
    attributes: { kind: "human" },
  });
  at.addGrant({
    roomJoin: true,
    room: input.room,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: false,
  });
  return at.toJwt();
}
