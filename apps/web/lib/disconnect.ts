import { DisconnectReason } from "livekit-client";

/**
 * Whether a call ended because it failed: it couldn't connect, or it dropped and LiveKit
 * couldn't get it back (then there's no reason at all). Not when the person left, was
 * removed (or came in again from another tab), or the meeting ended.
 */
export function callFailed(reason: DisconnectReason | undefined): boolean {
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED: // Leave, closing the tab, or leaving while it connects
    case DisconnectReason.PARTICIPANT_REMOVED:
    case DisconnectReason.DUPLICATE_IDENTITY:
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.ROOM_CLOSED:
      return false;
    default:
      return true;
  }
}
