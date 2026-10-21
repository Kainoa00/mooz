import { WebhookReceiver } from "livekit-server-sdk";
import { isUnwelcomeAgent, isUnwelcomePerson, noteBridgePresence, revokeIfNameTakenWhileAway } from "@/lib/agents";
import { endMeeting } from "@/lib/cleanup";
import { endRoomConnectors, noteConnectorPresence } from "@/lib/connector-agents";
import { forgetAgent } from "@/lib/connector-queue";
import { getDb } from "@/lib/db";
import { endFloor, leaveFloors } from "@/lib/floor";
import { errorResponse, HttpError, readCapped } from "@/lib/http";
import { livekitConfig, removeFromRoom } from "@/lib/livekit";
import { getNotesPolicy } from "@/lib/notes";
import { publishRoomState } from "@/lib/room-state";
import { getRoomByLivekitName, notePersonPresence } from "@/lib/rooms";
import { noteRoomWebhook, noteWebhook } from "@/lib/webhook-seen";

/**
 * LiveKit calls this for room events (configured in livekit.yaml). A removed agent (or one
 * from a meeting that ended) that reconnects with a token it still holds is kicked the moment
 * it joins, as is a person coming in under a name an agent took while they were away. And a
 * room LiveKit starts again (after everyone left) gets its notes policy back. A
 * connector agent whose tab leaves may come back for a couple of minutes (a reload);
 * after that it's out, with its questions. An agent that leaves gives up its turns (a bridge
 * agent can't take more until it's back); a late "left" for a connection it already replaced
 * changes nothing. When the meeting ends, its connector agents are
 * done, its floor is forgotten, and so is everyone who was in it (lib/cleanup.ts).
 */
const FIRST_WEBHOOK = Symbol.for("mooz.firstWebhook");

/** One line in the logs when LiveKit's webhook first gets through (the deploy guide checks for it). */
function noteFirstWebhook(): void {
  const g = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (g[FIRST_WEBHOOK]) return;
  g[FIRST_WEBHOOK] = true;
  console.log("LiveKit webhooks are reaching mooz.");
}

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
    noteFirstWebhook();
    const identity = event.participant?.identity;
    const sid = event.participant?.sid;
    const room = event.room?.name;
    const db = getDb();
    noteWebhook(db);
    if (room) noteRoomWebhook(db, room);
    if (event.event === "participant_joined" && identity && room) {
      revokeIfNameTakenWhileAway(db, identity); // before its return is noted: then it's unwelcome
      // A person turned away isn't noted as here, so the "left" LiveKit sends for the kick is for
      // a session never noted, and doesn't hold their name for another 2 minutes.
      const unwelcomePerson = isUnwelcomePerson(db, identity, event.participant?.name);
      noteBridgePresence(db, identity, sid, true);
      if (!unwelcomePerson) notePersonPresence(db, identity, sid, true);
      if (unwelcomePerson || isUnwelcomeAgent(db, identity)) {
        await removeFromRoom(room, identity);
      } else if (noteConnectorPresence(db, identity, sid, true) === "expired") {
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
        endMeeting(db, meeting.slug);
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
