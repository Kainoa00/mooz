import { forgetAgent } from "./connector-queue";
import { removeFromRoom } from "./livekit";

/**
 * Disconnect agents whose approval was just revoked, and drop any questions they held.
 * Best effort: one that stays connected can't do anything (and the webhook kicks it if
 * it reconnects).
 */
export async function removeAllFromRooms(kicks: readonly { livekitRoom: string; identity: string }[]): Promise<void> {
  for (const kick of kicks) {
    forgetAgent(kick.identity);
    await removeFromRoom(kick.livekitRoom, kick.identity).catch((err: unknown) => {
      console.error("could not disconnect a revoked agent", err);
    });
  }
}
