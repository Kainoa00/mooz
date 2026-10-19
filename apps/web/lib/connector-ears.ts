import { AddressDetector, type Via } from "./addressing";

/**
 * A connector agent's ears, in its owner's tab: what it heard lately (to send along with
 * a question) and whether a line addresses it, with the bridge's rules: `@Name` or its
 * name opening or closing what's said; its name alone opens a few seconds for that
 * person's next sentence; other agents get only a few turns in a row.
 */

export const FOLLOW_UP_MS = 8000;
export const MAX_AGENT_STREAK = 3;
export const WINDOW_MS = 10 * 60 * 1000;
export const MAX_LINES = 500;
/** What the tab sends with a question, in characters (the server keeps the newest 12,000). */
export const MAX_SNAPSHOT_CHARS = 48_000;
/** One question per person this often: more is someone running up the owner's bill. */
export const ASK_COOLDOWN_MS = 5000;

export interface HeardLine {
  identity: string;
  /** The person behind the speaker (an agent stands for its owner). */
  person: string;
  kind: "human" | "agent";
  text: string;
  via: Via;
  replyTo?: string;
  sources?: string[];
}

/** A line as the server takes it (POST …/questions). */
export interface SnapshotLine {
  identity: string;
  text: string;
  via: Via;
  at: number;
  reply_to?: string;
  sources?: string[];
}

export type Heard =
  | { kind: "question"; asker: string; replyTo: string; text: string }
  | { kind: "wake"; asker: string; replyTo: string };

export class ConnectorEars {
  private readonly detector: AddressDetector;
  private readonly log: SnapshotLine[] = [];
  private readonly followUp = new Map<string, number>();
  private readonly lastAsked = new Map<string, number>();
  private agentStreak = 0;

  constructor(
    name: string,
    private readonly self: string,
    private readonly clock: () => number = Date.now,
  ) {
    this.detector = new AddressDetector(name);
  }

  /** Something someone said or typed. Returns what to do about it, if it was for us. */
  hear(line: HeardLine): Heard | null {
    if (line.identity === this.self) return null;
    const at = this.clock();
    this.remember({
      identity: line.identity,
      text: line.text,
      via: line.via,
      at,
      ...(line.replyTo ? { reply_to: line.replyTo } : {}),
      ...(line.sources?.length ? { sources: line.sources } : {}),
    });
    if (line.kind === "human") this.agentStreak = 0;

    // Anything this person says closes their follow-up window.
    const deadline = this.followUp.get(line.identity);
    this.followUp.delete(line.identity);
    const addressed = this.detector.check(line.text, line.via);
    let text: string;
    if (addressed === null) {
      if (deadline === undefined || at > deadline) return null;
      text = line.text.trim();
    } else {
      text = addressed.question;
    }
    if (text) {
      const last = this.lastAsked.get(line.identity);
      if (last !== undefined && at - last < ASK_COOLDOWN_MS) return null;
    }
    if (line.kind === "agent") {
      if (this.agentStreak >= MAX_AGENT_STREAK) return null;
      this.agentStreak += 1;
    }
    if (!text) {
      this.followUp.set(line.identity, at + FOLLOW_UP_MS);
      return { kind: "wake", asker: line.identity, replyTo: line.person };
    }
    this.lastAsked.set(line.identity, at);
    return { kind: "question", asker: line.identity, replyTo: line.person, text };
  }

  /**
   * Something the agent itself said (it's part of the meeting too), with whose words it
   * carries, so the line leaves the assistant's view if any of them opts out later.
   */
  said(text: string, replyTo?: string, sources?: string[]): void {
    this.remember({
      identity: this.self,
      text,
      via: "chat",
      at: this.clock(),
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(sources?.length ? { sources } : {}),
    });
  }

  /** The last 10 minutes, oldest first, as much of the newest as fits in `maxChars`. */
  snapshot(maxChars = MAX_SNAPSHOT_CHARS): SnapshotLine[] {
    const cutoff = this.clock() - WINDOW_MS;
    const recent = this.log.filter((l) => l.at >= cutoff);
    let size = 0;
    let from = recent.length;
    while (from > 0 && size + recent[from - 1].text.length <= maxChars) size += recent[--from].text.length;
    return recent.slice(from);
  }

  private remember(line: SnapshotLine): void {
    this.log.push(line);
    const cutoff = this.clock() - WINDOW_MS;
    while (this.log.length > MAX_LINES || (this.log.length && this.log[0].at < cutoff)) this.log.shift();
  }
}
