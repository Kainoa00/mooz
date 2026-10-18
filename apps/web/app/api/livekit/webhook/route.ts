import { WebhookReceiver } from "livekit-server-sdk";
import { isRevokedAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";
import { errorResponse, HttpError } from "@/lib/http";
import { livekitConfig, removeFromRoom, setRoomMetadata } from "@/lib/livekit";
import { getNotesPolicy, notesMetadata } from "@/lib/notes";
import { getRoomByLivekitName } from "@/lib/rooms";

/**
 * LiveKit calls this for room events (configured in livekit.yaml). A removed agent
 * that reconnects with a token it still holds is kicked the moment it joins, and a
 * room LiveKit starts again (after everyone left) gets its notes policy back.
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
    if (event.event === "participant_joined" && identity && room && isRevokedAgent(getDb(), identity)) {
      await removeFromRoom(room, identity);
    }
    if (event.event === "room_started" && room) {
      const meeting = getRoomByLivekitName(getDb(), room);
      if (meeting && getNotesPolicy(getDb(), meeting.slug)) await setRoomMetadata(room, notesMetadata(true));
    }
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
