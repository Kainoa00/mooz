import { AccessToken, TrackSource } from "livekit-server-sdk";
import type { AgentIdentity } from "./agents";

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

/**
 * A join token for an approved agent: microphone audio and data only (no camera,
 * no screen share), with its owner baked into attributes it cannot change.
 */
export async function mintAgentToken(agent: AgentIdentity): Promise<string> {
  const { apiKey, apiSecret } = livekitConfig();
  const at = new AccessToken(apiKey, apiSecret, {
    identity: agent.identity,
    name: agent.name,
    ttl: TOKEN_TTL,
    attributes: {
      kind: "agent",
      door: "bridge",
      owner_id: agent.ownerIdentity,
      owner_name: agent.ownerName,
    },
  });
  at.addGrant({
    roomJoin: true,
    room: agent.slug,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: false,
  });
  return at.toJwt();
}
