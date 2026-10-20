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
import { useCallback, useState } from "react";
import { isAgent } from "@/lib/labels";
import { AgentCard } from "./AgentCard";
import { AgentRequestsTray } from "./AgentRequestsTray";
import { AgentsPausedBanner } from "./AgentsPausedBanner";
import { BringAgentDialog } from "./BringAgentDialog";
import { ChatPanel } from "./ChatPanel";
import { ConnectorAgent, type BroughtConnector } from "./ConnectorAgent";
import { FloorStrip } from "./FloorStrip";
import { JoinForm, type JoinResult } from "./JoinForm";
import { MeetingContext } from "./MeetingContext";
import { MoozTile } from "./MoozTile";
import { NotesBanner } from "./NotesBanner";
import { NotesPolicyToggle } from "./NotesPolicyToggle";
import { TaskPanel } from "./TaskPanel";

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

const broughtKey = (slug: string) => `mooz.connector.${slug}`;

function readBrought(slug: string): BroughtConnector | null {
  try {
    const saved = window.sessionStorage.getItem(broughtKey(slug));
    return saved ? (JSON.parse(saved) as BroughtConnector) : null;
  } catch {
    return null; // on the server, nothing saved, or storage is off
  }
}

/** The connector this tab brought here, kept across reloads (this tab only). */
function useBroughtConnector(slug: string): [BroughtConnector | null, (c: BroughtConnector | null) => void] {
  // Read once on mount: it's only rendered after joining, so the server's null never shows.
  const [connector, setConnector] = useState<BroughtConnector | null>(() => readBrought(slug));
  const update = useCallback(
    (c: BroughtConnector | null) => {
      setConnector(c);
      try {
        if (c) window.sessionStorage.setItem(broughtKey(slug), JSON.stringify(c));
        else window.sessionStorage.removeItem(broughtKey(slug));
      } catch {
        // it still works until this tab reloads
      }
    },
    [slug],
  );
  return [connector, update];
}

export function MeetingRoom({ slug }: { slug: string }) {
  const [session, setSession] = useState<JoinResult | null>(null);
  const [connector, setConnector] = useBroughtConnector(slug);

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
              <BringAgentDialog slug={slug} onBringConnector={setConnector} />
            </span>
          </header>
          <NotesBanner slug={slug} />
          <AgentsPausedBanner slug={slug} />
          <FloorStrip />
          {session.isHost && <AgentRequestsTray slug={slug} />}
          <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(0,40%)] md:grid-cols-[1fr_320px] md:grid-rows-1">
            <div className="flex min-h-0 flex-col">
              <Stage />
            </div>
            <div className="flex min-h-0 flex-col border-t border-zinc-800 md:border-l md:border-t-0">
              <TaskPanel />
              <ChatPanel />
            </div>
          </div>
          {connector && (
            <ConnectorAgent key={connector.requestId} slug={slug} connector={connector} onEnded={() => setConnector(null)} />
          )}
          <ControlBar controls={{ chat: false }} />
          <RoomAudioRenderer />
        </LiveKitRoom>
      </div>
    </MeetingContext.Provider>
  );
}
