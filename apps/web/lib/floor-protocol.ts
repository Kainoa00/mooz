/**
 * The meeting's floor as everyone sees it (safe to use in the client): part of the LiveKit
 * room metadata, which only the server sets. `speaking` and `next` are agent identities;
 * `paused` means a reply between agents is held until a person lets them continue.
 */

/** Agent-to-agent turns in a row before the next one waits for a person. */
export const MAX_AGENT_STREAK = 3;

export interface FloorState {
  speaking: string | null;
  next: string | null;
  paused: boolean;
}

export const NO_FLOOR: FloorState = { speaking: null, next: null, paused: false };

const id = (v: unknown) => (typeof v === "string" && v ? v : null);

export function parseFloor(metadata: string | undefined): FloorState {
  if (!metadata) return NO_FLOOR;
  try {
    const floor = (JSON.parse(metadata) as { floor?: unknown } | null)?.floor;
    if (typeof floor !== "object" || floor === null) return NO_FLOOR;
    const { speaking, next, paused } = floor as Record<string, unknown>;
    return { speaking: id(speaking), next: id(next), paused: paused === true };
  } catch {
    return NO_FLOOR;
  }
}

/** "🤖 Kainoa's Atlas is speaking · next: 🤖 Zach's Nova", or null when the floor is quiet. */
export function floorText(floor: FloorState, label: (identity: string) => string | undefined): string | null {
  const speaking = floor.speaking ? label(floor.speaking) : undefined;
  const next = floor.next ? label(floor.next) : undefined;
  if (speaking && next) return `${speaking} is speaking · next: ${next}`;
  if (speaking) return `${speaking} is speaking`;
  if (next) return `Next: ${next}`;
  return null;
}
