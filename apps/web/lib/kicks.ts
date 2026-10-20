import { forgetAgent } from "./connector-queue";
import { leaveFloors } from "./floor";
import { removeFromRoom } from "./livekit";
import "./room-state"; // tells the meeting when the floor changes

/**
 * Disconnect agents whose approval was just revoked, and drop any questions and turns they held.
 * Best effort: one that stays connected can't do anything (and the webhook kicks it if
 * it reconnects).
 */
export async function removeAllFromRooms(kicks: readonly { livekitRoom: string; identity: string }[]): Promise<void> {
  for (const kick of kicks) {
    forgetAgent(kick.identity);
    leaveFloors(kick.identity);
    await removeFromRoom(kick.livekitRoom, kick.identity).catch((err: unknown) => {
      console.error("could not disconnect a revoked agent", err);
    });
  }
}
