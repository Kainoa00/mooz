import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "./db";
import { noteWebhook, webhookArrives } from "./webhook-seen";
import { useTestEnv } from "@/test/helpers";

beforeEach(useTestEnv);

const DAY = 24 * 60 * 60 * 1000;

describe("whether LiveKit's webhook reaches this server", () => {
  it("is no until it has, and for a day after it last did", () => {
    const db = getDb();
    const now = Date.now();
    expect(webhookArrives(db, now)).toBe(false);
    noteWebhook(db, now);
    expect(webhookArrives(db, now + DAY - 1)).toBe(true);
    expect(webhookArrives(db, now + DAY)).toBe(false);
  });

  it("writes at most once a minute, and never goes back", () => {
    const db = getDb();
    const now = Date.now();
    noteWebhook(db, now);
    noteWebhook(db, now + 30_000);
    noteWebhook(db, now - DAY);
    const seen = () => (db.prepare("SELECT value FROM server_state").get() as { value: number }).value;
    expect(seen()).toBe(now);
    noteWebhook(db, now + 61_000);
    expect(seen()).toBe(now + 61_000);
  });
});
