"use client";

import { useRoomContext } from "@livekit/components-react";
import type { ReceivedChatMessage } from "@livekit/components-react";
import { RoomEvent, type Participant } from "livekit-client";
import { useEffect, useRef, useState, type Dispatch } from "react";
import { parseFloor } from "@/lib/floor-protocol";
import type { MeetingRecord, RecordEvent, Seen } from "@/lib/meeting-record";
import { summaryFileName, toMarkdown } from "@/lib/meeting-summary";
import { MOOZ_TOPIC, parseNotesAnnouncement } from "@/lib/notes-protocol";

const seen = (p: Participant): Seen => ({ identity: p.identity, name: p.name, attributes: { ...p.attributes } });

/**
 * The host's tab keeping its record of the meeting (agents' public words, who was there,
 * pauses, note keepers) for the summary. Renders nothing; the record is only in memory.
 */
export function MeetingRecorder({
  chat,
  dispatch,
}: {
  chat: readonly ReceivedChatMessage[];
  dispatch: Dispatch<RecordEvent>;
}) {
  const room = useRoomContext();

  useEffect(() => {
    const present = (...people: Participant[]) => dispatch({ type: "present", at: Date.now(), people: people.map(seen) });
    // Everyone here, now and on each (re)connect: the host's own identity and the people
    // already in the room only arrive with the connection.
    const everyone = () => present(room.localParticipant, ...room.remoteParticipants.values());
    everyone();
    const onParticipant = (p: Participant) => present(p);
    const onChanged = (_change: unknown, p: Participant) => present(p);
    const onFloor = (metadata: string) => dispatch({ type: "floor", at: Date.now(), paused: parseFloor(metadata).paused });
    const onData = (payload: Uint8Array, from?: Participant, _kind?: unknown, topic?: string) => {
      if (topic !== MOOZ_TOPIC || !from) return;
      const state = parseNotesAnnouncement(payload);
      if (state) dispatch({ type: "notes", at: Date.now(), from: seen(from), state });
    };
    onFloor(room.metadata ?? "");
    room
      .on(RoomEvent.Connected, everyone)
      .on(RoomEvent.ParticipantConnected, onParticipant)
      .on(RoomEvent.ParticipantAttributesChanged, onChanged)
      .on(RoomEvent.ParticipantNameChanged, onChanged)
      .on(RoomEvent.RoomMetadataChanged, onFloor)
      .on(RoomEvent.DataReceived, onData);
    return () => {
      room
        .off(RoomEvent.Connected, everyone)
        .off(RoomEvent.ParticipantConnected, onParticipant)
        .off(RoomEvent.ParticipantAttributesChanged, onChanged)
        .off(RoomEvent.ParticipantNameChanged, onChanged)
        .off(RoomEvent.RoomMetadataChanged, onFloor)
        .off(RoomEvent.DataReceived, onData);
    };
  }, [room, dispatch]);

  const handled = useRef(new Set<string>());
  useEffect(() => {
    for (const m of chat) {
      if (handled.current.has(m.id)) continue;
      handled.current.add(m.id);
      // Only what a well-formed message carries: an older client's chat packet can hold anything.
      if (typeof m.message !== "string") continue;
      const attributes = Object.fromEntries(Object.entries(m.attributes ?? {}).filter(([, v]) => typeof v === "string"));
      dispatch({
        type: "chat",
        at: Date.now(), // when this tab saw it, as the file says: the sender picks its own timestamp
        id: m.id,
        from: m.from ? seen(m.from) : undefined,
        text: m.message,
        attributes,
      });
    }
  }, [chat, dispatch]);

  return null;
}

function download(record: MeetingRecord): void {
  const blob = new Blob([toMarkdown(record)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = summaryFileName(record);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The host's header button. */
export function DownloadSummaryButton({ record }: { record: MeetingRecord }) {
  return (
    <button
      type="button"
      data-testid="summary-download"
      onClick={() => download(record)}
      title="Agents' public words, who was there, pauses and note keepers. Nobody's own words."
      className="rounded-lg border border-zinc-600 px-3 py-1.5 text-sm"
    >
      Download summary
    </button>
  );
}

/** After the host leaves: the record is still in this tab until they discard it. */
export function LeftMeeting({
  record,
  onDiscard,
  onRejoin,
}: {
  record: MeetingRecord;
  onDiscard: () => void;
  onRejoin: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <main data-testid="left-meeting" className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold">You left the meeting</h1>
      <p className="text-sm text-muted">
        This tab kept a summary: what the agents said in public, who was there, and when the agents paused. Nobody&apos;s
        own words, no private answers (from agents that mark them), and nothing to do with anyone who asked to be left out. It&apos;s only here, and
        goes when you discard it or close this tab.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid="summary-download" onClick={() => download(record)} className="rounded-lg bg-accent px-4 py-2 text-white">
          Download the meeting summary
        </button>
        <button
          type="button"
          data-testid="summary-copy"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(toMarkdown(record))
              .then(() => setCopied(true))
              .catch(() => undefined);
          }}
          className="rounded-lg border border-zinc-400 px-4 py-2"
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" data-testid="summary-discard" onClick={onDiscard} className="rounded-lg border border-zinc-400 px-4 py-2">
          Discard
        </button>
      </div>
      <button type="button" onClick={onRejoin} className="self-start text-sm underline">
        Join again
      </button>
    </main>
  );
}
