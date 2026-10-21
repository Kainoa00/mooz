import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, openDb } from "./db";

const DAY = 24 * 60 * 60 * 1000;
let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("upgrading to session expiry", () => {
  it("keeps a room people still meet on, and ends old sessions when their cookies did", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mooz-db-"));
    const file = path.join(dir, "mooz.db");
    const expiry = MIGRATIONS.findIndex((m) => m.includes("ADD COLUMN last_active_at"));
    const before = new DatabaseSync(file);
    for (const m of MIGRATIONS.slice(0, expiry)) before.exec(m);
    before.exec(`PRAGMA user_version = ${expiry}`);
    const made = Date.now() - 40 * DAY;
    before.prepare("INSERT INTO rooms (slug, host_secret_hash, created_at, livekit_room) VALUES ('abc-defg-hij', 'h', ?, 'lk')").run(made);
    before
      .prepare(
        "INSERT INTO participants (identity, room_slug, name, is_host, secret_hash, created_at) VALUES ('p_1', 'abc-defg-hij', 'Zach', 0, 's', ?)",
      )
      .run(made + DAY);
    before.close();

    const db = openDb(file);
    const room = db.prepare("SELECT last_active_at, host_expires_at FROM rooms").get() as { last_active_at: number; host_expires_at: number };
    expect(room.last_active_at).toBeGreaterThan(Date.now() - 60_000); // not deleted at the next sweep
    expect(room.host_expires_at).toBe(made + DAY); // as the host's cookie was
    const person = db.prepare("SELECT expires_at FROM participants").get() as { expires_at: number };
    expect(person.expires_at).toBe(made + 2 * DAY);
    db.close();
  });
});
