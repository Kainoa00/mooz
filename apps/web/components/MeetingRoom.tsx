"use client";

import {
  ControlBar,
  GridLayout,
  LiveKitRoom,
  RoomAudioRenderer,
  useParticipants,
  useTracks,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import { useState } from "react";
import { isAgent } from "@/lib/labels";
import { AgentCard } from "./AgentCard";
import { AgentRequestsTray } from "./AgentRequestsTray";
import { BringAgentDialog } from "./BringAgentDialog";
import { ChatPanel } from "./ChatPanel";
import { JoinForm, type JoinResult } from "./JoinForm";
import { MeetingContext } from "./MeetingContext";
import { MoozTile } from "./MoozTile";
import { NotesBanner } from "./NotesBanner";
import { NotesPolicyToggle } from "./NotesPolicyToggle";

function Stage() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  ).filter((t) => !isAgent(t.participant));
  const agents = useParticipants().filter((p) => isAgent(p));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {agents.length > 0 && (
        <ul aria-label="Agents in this meeting" className="flex gap-2 overflow-x-auto p-2">
          {agents.map((p) => (
            <AgentCard key={p.identity} participant={p} />
          ))}
        </ul>
      )}
      <GridLayout tracks={tracks} className="min-h-0 flex-1">
        <MoozTile />
      </GridLayout>
    </div>
  );
}

export function MeetingRoom({ slug }: { slug: string }) {
  const [session, setSession] = useState<JoinResult | null>(null);

  if (!session) return <JoinForm slug={slug} onJoined={setSession} />;

  return (
    <MeetingContext.Provider value={{ slug, isHost: session.isHost }}>
      {/* LiveKit's unlayered CSS sizes the room to 100% of its parent, so the parent fills the viewport. */}
      <div className="fixed inset-0 bg-[#111]">
        <LiveKitRoom
          serverUrl={session.url}
          token={session.token}
          connect
          audio
          video
          data-lk-theme="default"
          className="flex flex-col"
          onDisconnected={() => setSession(null)}
        >
          <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2 text-sm">
            <span className="font-semibold">mooz</span>
            <span className="font-mono text-muted">{slug}</span>
            <span className="flex items-center gap-3">
              <span>{session.isHost ? "You are the host" : session.name}</span>
              {session.isHost && <NotesPolicyToggle slug={slug} />}
              <BringAgentDialog slug={slug} />
            </span>
          </header>
          <NotesBanner slug={slug} />
          {session.isHost && <AgentRequestsTray slug={slug} />}
          <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(0,40%)] md:grid-cols-[1fr_320px] md:grid-rows-1">
            <div className="flex min-h-0 flex-col">
              <Stage />
            </div>
            <ChatPanel />
          </div>
          <ControlBar controls={{ chat: false }} />
          <RoomAudioRenderer />
        </LiveKitRoom>
      </div>
    </MeetingContext.Provider>
  );
}
