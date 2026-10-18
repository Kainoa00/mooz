"use client";

import { useConnectionState, useLocalParticipant, useParticipants, useRoomContext } from "@livekit/components-react";
import { ConnectionState, type TextStreamReader } from "livekit-client";
import { useEffect, useMemo, useState } from "react";
import { isAgent, ownedName } from "@/lib/labels";
import { MOOZ_TOPIC } from "@/lib/notes-protocol";
import {
  TASKS_QUERY,
  TASKS_TOPIC,
  applyTaskEvent,
  cancelTaskMessage,
  isActive,
  parseTaskEvent,
  readCapped,
  sortTasks,
  type TaskRow,
  type TaskState,
} from "@/lib/tasks-protocol";

const STATE_LABEL: Record<TaskState, string> = {
  queued: "Waiting",
  working: "Working",
  done: "Done",
  failed: "Couldn't finish",
  cancelled: "Stopped",
};

const STATE_STYLE: Record<TaskState, string> = {
  queued: "bg-zinc-700 text-zinc-100",
  working: "bg-sky-800 text-sky-50",
  done: "bg-emerald-800 text-emerald-50",
  failed: "bg-red-900 text-red-50",
  cancelled: "bg-zinc-800 text-zinc-300",
};

/**
 * What agents are researching in the background. Everyone sees it (like the notes banner);
 * a private task shows only its state to anyone but its owner, who can also cancel.
 */
export function TaskPanel() {
  const room = useRoomContext();
  const connection = useConnectionState();
  const { localParticipant } = useLocalParticipant();
  const participants = useParticipants();
  const [tasks, setTasks] = useState<Map<string, TaskRow>>(new Map());

  useEffect(() => {
    const handle = async (reader: TextStreamReader, info: { identity: string }) => {
      let text: string | null;
      try {
        text = await readCapped(reader);
      } catch {
        return; // the stream was cut off
      }
      if (text === null) return; // far too long to be a task update
      const from = room.remoteParticipants.get(info.identity);
      const event = parseTaskEvent(text);
      if (!from || !event) return;
      setTasks((prev) => {
        const next = new Map(prev);
        return applyTaskEvent(next, from, event) ? next : prev;
      });
    };
    room.registerTextStreamHandler(TASKS_TOPIC, (reader, info) => void handle(reader, info));
    return () => room.unregisterTextStreamHandler(TASKS_TOPIC);
  }, [room]);

  // On joining and after every reconnect, ask agents what they're working on.
  useEffect(() => {
    if (connection !== ConnectionState.Connected) return;
    room.localParticipant.publishData(TASKS_QUERY, { reliable: true, topic: MOOZ_TOPIC }).catch(() => {});
  }, [connection, room]);

  const agents = useMemo(
    () => new Map(participants.filter((p) => isAgent(p)).map((p) => [p.identity, p])),
    [participants],
  );
  // An agent that left takes its tasks with it.
  const rows = sortTasks([...tasks.values()].filter((t) => agents.has(t.agent)));
  if (rows.length === 0) return null;

  function cancel(task: TaskRow) {
    room.localParticipant
      .publishData(cancelTaskMessage(task.id), {
        reliable: true,
        topic: MOOZ_TOPIC,
        destinationIdentities: [task.agent],
      })
      .catch(() => {});
  }

  return (
    <section
      aria-label="Agent tasks"
      data-testid="task-panel"
      className="max-h-[45%] shrink-0 overflow-y-auto border-b border-zinc-800 p-3 text-sm"
    >
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Agent tasks</h2>
      <ul className="flex flex-col gap-2">
        {rows.map((t) => {
          const agent = agents.get(t.agent)!;
          const mine = t.owner === localParticipant.identity;
          const title = t.private && !mine ? `Private task for ${agent.attributes.owner_name ?? "its owner"}` : t.title;
          return (
            <li
              key={`${t.agent}:${t.id}`}
              data-testid="task-row"
              data-state={t.state}
              className="flex flex-col gap-1 rounded-lg border border-zinc-800 p-2"
            >
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted">🤖 {ownedName(agent)}</span>
                <span data-testid="task-state" className={`rounded px-1.5 py-0.5 ${STATE_STYLE[t.state]}`}>
                  {STATE_LABEL[t.state]}
                </span>
              </div>
              <p data-testid="task-title" className="font-medium">
                {t.private ? "🔒 " : ""}
                {title}
              </p>
              {isActive(t) && t.progress.length > 0 && (
                <p data-testid="task-progress" className="text-xs text-muted">
                  {t.progress[t.progress.length - 1]}
                </p>
              )}
              {t.summary && <p data-testid="task-summary">{t.summary}</p>}
              {t.error && <p className="text-xs text-red-300">{t.error}</p>}
              {t.details && (
                <details>
                  <summary className="cursor-pointer text-xs underline">Details</summary>
                  <p data-testid="task-details" className="mt-1 whitespace-pre-wrap break-words text-xs">
                    {t.details}
                  </p>
                </details>
              )}
              {mine && isActive(t) && (
                <button
                  type="button"
                  data-testid="task-cancel"
                  onClick={() => cancel(t)}
                  className="self-start rounded border border-zinc-700 px-2 py-0.5 text-xs hover:bg-zinc-800"
                >
                  Cancel
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
