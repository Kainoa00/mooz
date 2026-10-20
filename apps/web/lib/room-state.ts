import { type Db, getDb } from "./db";
import { floorView, setFloorListener } from "./floor";
import { setRoomMetadata } from "./livekit";
import { getNotesPolicy } from "./notes";
import { getRoom } from "./rooms";

/**
 * The one LiveKit room-metadata document everyone in a meeting reads (only the server sets
 * it): whether the host allows agent notes, and who has the floor.
 */
export function roomMetadata(db: Db, slug: string): string {
  return JSON.stringify({ notes_allowed: getNotesPolicy(db, slug), floor: floorView(slug) });
}

const CHAINS = Symbol.for("mooz.roomStateChains");
const PENDING = Symbol.for("mooz.roomStatePending");

function shared<T>(key: symbol, make: () => T): T {
  // On globalThis: every route bundle in this process shares these.
  const g = globalThis as unknown as Record<symbol, T | undefined>;
  return (g[key] ??= make());
}

/**
 * Send the meeting its current state. Updates for one meeting go out one at a time, each
 * built when its turn comes, so a slow one can't land after (and undo) a newer one.
 */
export function publishRoomState(db: Db, slug: string): Promise<void> {
  const chains = shared(CHAINS, () => new Map<string, Promise<void>>());
  const run = (chains.get(slug) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const room = getRoom(db, slug);
      if (room) await setRoomMetadata(room.livekitRoom, roomMetadata(db, slug));
    });
  chains.set(slug, run);
  run
    .finally(() => {
      if (chains.get(slug) === run) chains.delete(slug);
    })
    .catch(() => undefined);
  return run;
}

/** Floor changes come in bursts (one turn ends, the next starts): one update for each. */
export const PUBLISH_DELAY_MS = 100;

const pending = () => shared(PENDING, () => new Map<string, ReturnType<typeof setTimeout>>());

export function publishRoomStateSoon(slug: string): void {
  if (pending().has(slug)) return;
  const timer = setTimeout(() => {
    pending().delete(slug);
    publishRoomState(getDb(), slug).catch((err: unknown) => console.error("Couldn't update the meeting's floor", err));
  }, PUBLISH_DELAY_MS);
  timer.unref?.();
  pending().set(slug, timer);
}

export function resetRoomStateForTests(): void {
  for (const timer of pending().values()) clearTimeout(timer);
  pending().clear();
}

setFloorListener(publishRoomStateSoon);
