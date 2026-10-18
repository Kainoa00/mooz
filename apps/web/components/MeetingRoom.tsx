"use client";

import {
  ControlBar,
  GridLayout,
  LiveKitRoom,
  RoomAudioRenderer,
  useTracks,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import { useState } from "react";
import { ChatPanel } from "./ChatPanel";
import { JoinForm, type JoinResult } from "./JoinForm";
import { MoozTile } from "./MoozTile";

function Stage() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  return (
    <GridLayout tracks={tracks} className="h-full">
      <MoozTile />
    </GridLayout>
  );
}

export function MeetingRoom({ slug }: { slug: string }) {
  const [session, setSession] = useState<JoinResult | null>(null);

  if (!session) return <JoinForm slug={slug} onJoined={setSession} />;

  return (
    <LiveKitRoom
      serverUrl={session.url}
      token={session.token}
      connect
      audio
      video
      data-lk-theme="default"
      className="flex h-dvh flex-col"
      onDisconnected={() => setSession(null)}
    >
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2 text-sm">
        <span className="font-semibold">mooz</span>
        <span className="font-mono text-muted">{slug}</span>
        <span>{session.isHost ? "You are the host" : session.name}</span>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[1fr_320px]">
        <div className="min-h-0">
          <Stage />
        </div>
        <ChatPanel />
      </div>
      <ControlBar controls={{ chat: false }} />
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}
