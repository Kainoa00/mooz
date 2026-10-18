/**
 * Agents' background research, as the browser sees it (safe to use in the client).
 *
 * - Agents send task updates as JSON text streams on topic `mooz.tasks`. LiveKit stamps the
 *   sender, and a task counts only if it comes from an agent and belongs to that agent's own
 *   owner (the server-set `owner_id` attribute).
 * - A private task reaches its owner in full; everyone else gets "Private task" and its state.
 * - Browsers ask with `{"type": "tasks?"}` on (re)connect, and the owner can cancel with
 *   `{"type": "task.cancel", "id"}`, both on the `mooz.v0` data topic. Agents honor a cancel
 *   only from their owner.
 */

import { isAgent, type Labelled } from "./labels";

export const TASKS_TOPIC = "mooz.tasks";

export const TASK_STATES = ["queued", "working", "done", "failed", "cancelled"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export interface TaskEvent {
  id: string;
  state: TaskState;
  title: string;
  owner: string;
  private: boolean;
  progress: string[];
  summary: string;
  details: string;
  error: string;
  createdAt: number;
  updatedAt: number;
  seq: number;
}

export interface TaskRow extends TaskEvent {
  /** The agent working on it (its LiveKit identity). */
  agent: string;
}

const encode = (value: unknown): Uint8Array<ArrayBuffer> => new TextEncoder().encode(JSON.stringify(value));

export const TASKS_QUERY = encode({ type: "tasks?" });

export function cancelTaskMessage(id: string): Uint8Array<ArrayBuffer> {
  return encode({ type: "task.cancel", id });
}

const clip = (value: unknown, max: number): string | null =>
  typeof value === "string" ? value.slice(0, max) : null;

export function parseTaskEvent(text: string): TaskEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== "task" || !TASK_STATES.includes(m.state as TaskState)) return null;
  const id = clip(m.id, 40);
  const title = clip(m.title, 200);
  const owner = clip(m.owner, 100);
  const summary = clip(m.summary ?? "", 2_000);
  const details = clip(m.details ?? "", 20_000);
  const error = clip(m.error ?? "", 500);
  if (id === null || title === null || owner === null || summary === null || details === null || error === null) {
    return null;
  }
  if (!Array.isArray(m.progress) || !m.progress.every((p) => typeof p === "string")) return null;
  if (typeof m.seq !== "number" || typeof m.updated_at !== "number" || typeof m.created_at !== "number") {
    return null;
  }
  return {
    id,
    state: m.state as TaskState,
    title,
    owner,
    private: m.private === true,
    progress: (m.progress as string[]).slice(-5).map((p) => p.slice(0, 200)),
    summary,
    details,
    error,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    seq: m.seq,
  };
}

/** Add or update a task from `from`. Returns whether it was accepted. */
export function applyTaskEvent(
  tasks: Map<string, TaskRow>,
  from: Pick<Labelled, "attributes"> & { identity: string },
  event: TaskEvent,
): boolean {
  // Only agents report tasks, and only tasks their own owner asked for.
  if (!isAgent(from) || from.attributes.owner_id !== event.owner) return false;
  const key = `${from.identity}:${event.id}`;
  const known = tasks.get(key);
  if (known && known.seq >= event.seq) return false;
  tasks.set(key, { ...event, agent: from.identity });
  return true;
}

export const isActive = (t: Pick<TaskEvent, "state">) => t.state === "queued" || t.state === "working";

export function sortTasks(tasks: TaskRow[]): TaskRow[] {
  return [...tasks].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.updatedAt - a.updatedAt);
}
