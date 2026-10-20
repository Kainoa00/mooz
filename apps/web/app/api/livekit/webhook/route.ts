import { WebhookReceiver } from "livekit-server-sdk";
import { isRevokedAgent, noteBridgePresence } from "@/lib/agents";
import { endRoomConnectors, noteConnectorPresence } from "@/lib/connector-agents";
import { forgetAgent } from "@/lib/connector-queue";
import { getDb } from "@/lib/db";
import { endFloor, leaveFloors } from "@/lib/floor";
import { errorResponse, HttpError, readCapped } from "@/lib/http";
import { livekitConfig, removeFromRoom } from "@/lib/livekit";
import { getNotesPolicy } from "@/lib/notes";
import { publishRoomState } from "@/lib/room-state";
import { getRoomByLivekitName, notePersonPresence } from "@/lib/rooms";

/**
 * LiveKit calls this for room events (configured in livekit.yaml). A removed agent
 * that reconnects with a token it still holds is kicked the moment it joins, and a
 * room LiveKit starts again (after everyone left) gets its notes policy back. A
 * connector agent whose tab leaves may come back for a couple of minutes (a reload);
 * after that it's out, with its questions. An agent that leaves gives up its turns (a bridge
 * agent can't take more until it's back); a late "left" for a connection it already replaced
 * changes nothing. When the meeting ends, its connector agents are
 * done and its floor is forgotten.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const { apiKey, apiSecret } = livekitConfig();
    // Read (a bounded amount) before the signature check: anyone can post here.
    const body = await readCapped(req, 64 * 1024);
    if (body === null) throw new HttpError(413, "too_large", "Webhook body is too large");
    const event = await new WebhookReceiver(apiKey, apiSecret)
      .receive(body, req.headers.get("authorization") ?? undefined)
      .catch(() => {
        throw new HttpError(401, "invalid_signature", "Webhook signature did not verify");
      });
    const identity = event.participant?.identity;
    const sid = event.participant?.sid;
    const room = event.room?.name;
    const db = getDb();
    if (event.event === "participant_joined" && identity && room) {
      noteBridgePresence(db, identity, sid, true);
      notePersonPresence(db, identity, sid, true);
      if (isRevokedAgent(db, identity)) await removeFromRoom(room, identity);
      else if (noteConnectorPresence(db, identity, sid, true) === "expired") {
        forgetAgent(identity);
        await removeFromRoom(room, identity);
      }
    }
    if (event.event === "participant_left" && identity) {
      const connector = noteConnectorPresence(db, identity, sid, false) === "left";
      const bridge = noteBridgePresence(db, identity, sid, false);
      notePersonPresence(db, identity, sid, false);
      // Only the session that's in now gives up its turns (not a late "left" for an old one).
      if (connector || bridge) leaveFloors(identity);
    }
    if (event.event === "room_finished" && room) {
      const meeting = getRoomByLivekitName(db, room);
      if (meeting) {
        for (const agent of endRoomConnectors(db, meeting.slug)) forgetAgent(agent);
        endFloor(meeting.slug);
      }
    }
    if (event.event === "room_started" && room) {
      const meeting = getRoomByLivekitName(db, room);
      if (meeting && getNotesPolicy(db, meeting.slug)) await publishRoomState(db, meeting.slug);
    }
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
