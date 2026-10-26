import { DisconnectReason } from "livekit-client";
import { describe, expect, it } from "vitest";
import { callFailed } from "./disconnect";

describe("callFailed", () => {
  it("is not a failure when the person left, was removed, or the meeting ended", () => {
    for (const reason of [
      DisconnectReason.CLIENT_INITIATED, // Leave, closing the tab, or leaving while it connects
      DisconnectReason.PARTICIPANT_REMOVED,
      DisconnectReason.DUPLICATE_IDENTITY, // they came in again from another tab
      DisconnectReason.ROOM_DELETED,
      DisconnectReason.ROOM_CLOSED,
    ]) {
      expect(callFailed(reason), DisconnectReason[reason]).toBe(false);
    }
  });

  it("is a failure when the call couldn't connect or dropped", () => {
    for (const reason of [
      DisconnectReason.JOIN_FAILURE, // the server couldn't be reached
      DisconnectReason.UNKNOWN_REASON,
      DisconnectReason.USER_REJECTED, // the server turned the connection down
      DisconnectReason.SIGNAL_CLOSE,
      DisconnectReason.CONNECTION_TIMEOUT,
      DisconnectReason.MEDIA_FAILURE,
      DisconnectReason.STATE_MISMATCH,
      DisconnectReason.SERVER_SHUTDOWN,
    ]) {
      expect(callFailed(reason), DisconnectReason[reason]).toBe(true);
    }
  });

  it("is a failure with no reason: LiveKit gave up reconnecting", () => {
    expect(callFailed(undefined)).toBe(true);
  });
});
