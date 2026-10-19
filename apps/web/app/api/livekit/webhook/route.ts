import { WebhookReceiver } from "livekit-server-sdk";
import { isRevokedAgent } from "@/lib/agents";
import { endRoomConnectors, noteConnectorPresence } from "@/lib/connector-agents";
import { forgetAgent } from "@/lib/connector-queue";
import { getDb } from "@/lib/db";
import { errorResponse, HttpError } from "@/lib/http";
import { livekitConfig, removeFromRoom, setRoomMetadata } from "@/lib/livekit";
import { getNotesPolicy, notesMetadata } from "@/lib/notes";
import { getRoomByLivekitName } from "@/lib/rooms";

/**
 * LiveKit calls this for room events (configured in livekit.yaml). A removed agent
 * that reconnects with a token it still holds is kicked the moment it joins, and a
 * room LiveKit starts again (after everyone left) gets its notes policy back. A
 * connector agent whose tab leaves is out of the meeting (its assistant can't reach
 * it, and its questions are dropped) until the tab comes back, which it may do for a
 * couple of minutes; when the meeting ends, its connector agents are done.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const { apiKey, apiSecret } = livekitConfig();
    const body = await req.text();
    const event = await new WebhookReceiver(apiKey, apiSecret)
      .receive(body, req.headers.get("authorization") ?? undefined)
      .catch(() => {
        throw new HttpError(401, "invalid_signature", "Webhook signature did not verify");
      });
    const identity = event.participant?.identity;
    const room = event.room?.name;
    const db = getDb();
    if (event.event === "participant_joined" && identity && room) {
      if (isRevokedAgent(db, identity)) await removeFromRoom(room, identity);
      else noteConnectorPresence(db, identity, true);
    }
    if (event.event === "participant_left" && identity && noteConnectorPresence(db, identity, false)) {
      forgetAgent(identity);
    }
    if (event.event === "room_finished" && room) {
      const meeting = getRoomByLivekitName(db, room);
      if (meeting) for (const agent of endRoomConnectors(db, meeting.slug)) forgetAgent(agent);
    }
    if (event.event === "room_started" && room) {
      const meeting = getRoomByLivekitName(db, room);
      if (meeting && getNotesPolicy(db, meeting.slug)) await setRoomMetadata(room, notesMetadata(true));
    }
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
