import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import type { AgentIdentity } from "./agents";

export interface LivekitConfig {
  /** Public WebSocket URL handed to browsers and bridges. */
  url: string;
  /** Server-to-server HTTP URL for LiveKit's API (may be an internal address). */
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "livekit"]);

function isLocal(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function livekitConfig(): LivekitConfig {
  const url = required("LIVEKIT_URL");
  const apiSecret = required("LIVEKIT_API_SECRET");
  // The dev keys are public. Anyone holding them can mint any token, including
  // admin ones, so they must never protect a meeting reachable from outside.
  if (!isLocal(url) && (apiSecret.length < 32 || apiSecret === "secret")) {
    throw new Error(
      "LIVEKIT_API_SECRET must be a random secret of at least 32 characters when LiveKit is not on localhost",
    );
  }
  return {
    url,
    apiUrl: process.env.LIVEKIT_API_URL ?? url.replace(/^ws/, "http"),
    apiKey: required("LIVEKIT_API_KEY"),
    apiSecret,
  };
}

const TOKEN_TTL = "1h";

/**
 * A join token for a human participant. Participants cannot edit their own
 * attributes, so nobody can relabel themselves as an agent (or vice versa).
 */
export async function mintHumanToken(input: {
  /** The internal LiveKit room name (Room.livekitRoom), not the public slug. */
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
    room: agent.livekitRoom,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: false,
  });
  return at.toJwt();
}

/** Disconnect a participant now (used when the host removes an agent). */
export async function removeFromRoom(room: string, identity: string): Promise<void> {
  const { apiUrl, apiKey, apiSecret } = livekitConfig();
  try {
    await new RoomServiceClient(apiUrl, apiKey, apiSecret).removeParticipant(room, identity);
  } catch (err) {
    // Already gone (left, or never connected) is fine; anything else is not.
    if (!/not.?found/i.test(String(err))) throw err;
  }
}
