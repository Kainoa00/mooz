import { describe, expect, it } from "vitest";
import {
  TASKS_QUERY,
  applyTaskEvent,
  cancelTaskMessage,
  isActive,
  parseTaskEvent,
  sortTasks,
  type TaskRow,
} from "./tasks-protocol";

const event = (over: Record<string, unknown> = {}) => ({
  type: "task",
  id: "t_0a1b2c3d",
  state: "working",
  title: "Look into CI",
  owner: "p_kai",
  private: false,
  progress: ["Checking CI on main"],
  summary: "",
  details: "",
  error: "",
  created_at: 1,
  updated_at: 2,
  seq: 2,
  ...over,
});

const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));
const agent = { identity: "a_atlas", attributes: { kind: "agent", owner_id: "p_kai" } };

describe("task protocol", () => {
  it("parses a valid task event", () => {
    expect(parseTaskEvent(JSON.stringify(event()))).toMatchObject({ id: "t_0a1b2c3d", state: "working", seq: 2 });
  });

  it("rejects anything malformed", () => {
    for (const bad of [
      "{nope",
      JSON.stringify([1]),
      JSON.stringify(event({ type: "notes" })),
      JSON.stringify(event({ state: "exploded" })),
      JSON.stringify(event({ id: 5 })),
      JSON.stringify(event({ progress: "not a list" })),
      JSON.stringify(event({ seq: "2" })),
    ]) {
      expect(parseTaskEvent(bad)).toBeNull();
    }
  });

  it("caps what it keeps", () => {
    const parsed = parseTaskEvent(
      JSON.stringify(event({ title: "x".repeat(500), details: "y".repeat(50_000), progress: Array(20).fill("step") })),
    );
    expect(parsed!.title.length).toBeLessThanOrEqual(200);
    expect(parsed!.details.length).toBeLessThanOrEqual(20_000);
    expect(parsed!.progress).toHaveLength(5);
  });

  it("trusts only agents, and only about tasks for their own owner", () => {
    const tasks = new Map<string, TaskRow>();
    const human = { identity: "p_zach", attributes: { kind: "human" } };
    const otherOwner = { identity: "a_grok", attributes: { kind: "agent", owner_id: "p_zach" } };

    expect(applyTaskEvent(tasks, human, parseTaskEvent(JSON.stringify(event()))!)).toBe(false);
    expect(applyTaskEvent(tasks, otherOwner, parseTaskEvent(JSON.stringify(event()))!)).toBe(false);
    expect(applyTaskEvent(tasks, agent, parseTaskEvent(JSON.stringify(event()))!)).toBe(true);
    expect([...tasks.values()].map((t) => t.agent)).toEqual(["a_atlas"]);
  });

  it("ignores updates older than what it has", () => {
    const tasks = new Map<string, TaskRow>();
    applyTaskEvent(tasks, agent, parseTaskEvent(JSON.stringify(event({ state: "done", seq: 5 })))!);
    applyTaskEvent(tasks, agent, parseTaskEvent(JSON.stringify(event({ state: "working", seq: 3 })))!);
    expect([...tasks.values()][0].state).toBe("done");
  });

  it("keeps the same task id from two agents apart", () => {
    const tasks = new Map<string, TaskRow>();
    const grok = { identity: "a_grok", attributes: { kind: "agent", owner_id: "p_kai" } };
    applyTaskEvent(tasks, agent, parseTaskEvent(JSON.stringify(event()))!);
    applyTaskEvent(tasks, grok, parseTaskEvent(JSON.stringify(event()))!);
    expect(tasks.size).toBe(2);
  });

  it("puts active tasks first, newest first", () => {
    const row = (id: string, state: string, updated: number) =>
      ({ ...parseTaskEvent(JSON.stringify(event({ id, state, updated_at: updated })))!, agent: "a" }) as TaskRow;
    const sorted = sortTasks([row("t_00000001", "done", 9), row("t_00000002", "working", 1), row("t_00000003", "queued", 5)]);
    expect(sorted.map((t) => t.id)).toEqual(["t_00000003", "t_00000002", "t_00000001"]);
    expect(isActive(sorted[0])).toBe(true);
  });

  it("builds the query and cancel messages agents expect", () => {
    expect(decode(TASKS_QUERY)).toEqual({ type: "tasks?" });
    expect(decode(cancelTaskMessage("t_0a1b2c3d"))).toEqual({ type: "task.cancel", id: "t_0a1b2c3d" });
  });
});
