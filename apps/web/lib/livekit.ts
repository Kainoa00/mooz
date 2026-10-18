import { AccessToken, RoomServiceClient, ServerError, TrackSource } from "livekit-server-sdk";
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
/** Agent tokens are single-use and short-lived; LiveKit refreshes them while connected. */
const AGENT_TOKEN_TTL = "5m";

/**
 * A join token for a human participant. Participants cannot edit their own
 * attributes, so nobody can relabel themselves as an agent (or vice versa).
 */
export async function mintHumanToken(input: {
  /** The internal LiveKit room name (Room.livekitRoom), not the public slug. */
  room: string;
  identity: string;
  name: string;
  /** Leave this person out of agents' meeting notes (kept across reconnects). */
  notesOptOut?: boolean;
}): Promise<string> {
  const { apiKey, apiSecret } = livekitConfig();
  const attributes: Record<string, string> = { kind: "human" };
  if (input.notesOptOut) attributes.notes_opt_out = "1";
  const at = new AccessToken(apiKey, apiSecret, {
    identity: input.identity,
    name: input.name,
    ttl: TOKEN_TTL,
    attributes,
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
    ttl: AGENT_TOKEN_TTL,
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

function roomService(): RoomServiceClient {
  const { apiUrl, apiKey, apiSecret } = livekitConfig();
  return new RoomServiceClient(apiUrl, apiKey, apiSecret);
}

/** Run a room-service call where "no such room or participant" just means nothing to do. */
async function ignoringNotFound(call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
  } catch (err) {
    if (!(err instanceof ServerError && err.status === 404 && err.code === "not_found")) throw err;
  }
}

/** Disconnect a participant now (used when the host removes an agent). */
export async function removeFromRoom(room: string, identity: string): Promise<void> {
  // Already gone (left, or never connected) is fine; anything else is not.
  await ignoringNotFound(() => roomService().removeParticipant(room, identity));
}

/**
 * Set room metadata everyone in the room can read. A room nobody is in yet doesn't
 * exist in LiveKit; the webhook applies the metadata when it starts.
 */
export async function setRoomMetadata(room: string, metadata: string): Promise<void> {
  await ignoringNotFound(() => roomService().updateRoomMetadata(room, metadata));
}

/**
 * Set server-owned attributes on a participant (they can't change these themselves).
 * Someone not connected right now gets them in their next token instead.
 */
export async function setParticipantAttributes(
  room: string,
  identity: string,
  attributes: Record<string, string>,
): Promise<void> {
  await ignoringNotFound(() => roomService().updateParticipant(room, identity, { attributes }));
}
