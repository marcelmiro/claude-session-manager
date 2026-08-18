import { describe, expect, test } from "bun:test";
import { InboxStore } from "./inbox-store";

function fresh(): InboxStore {
  return new InboxStore(":memory:");
}

describe("verbs", () => {
  test("snooze parks with a wake time and re-arms auto_resumed", () => {
    const s = fresh();
    expect(s.snooze("a", 1000, 1)).toBe(true);
    expect(s.markAutoResumed("a", 2)).toBe(true);
    expect(s.markAutoResumed("a", 3)).toBe(false); // claim is at-most-once per stretch
    expect(s.dispositions().get("a")!.autoResumed).toBe(true);
    // re-snooze re-arms the wake
    expect(s.snooze("a", 2000, 3)).toBe(true);
    const d = s.dispositions().get("a")!;
    expect(d.until).toBe(2000);
    expect(d.autoResumed).toBe(false);
  });

  test("block replaces a snooze; both refuse archived sessions", () => {
    const s = fresh();
    s.snooze("a", 1000, 1);
    expect(s.block("a", "waiting on stripe", 2)).toBe(true);
    const d = s.dispositions().get("a")!;
    expect(d.kind).toBe("blocked");
    expect(d.until).toBeNull();
    s.archive("b", 1);
    expect(s.snooze("b", 1000, 2)).toBe(false);
    expect(s.block("b", "x", 2)).toBe(false);
  });

  test("archive clears the disposition; unarchive undoes; both refuse doubles", () => {
    const s = fresh();
    s.snooze("a", 1000, 1);
    expect(s.archive("a", 2)).toBe(true);
    expect(s.dispositions().has("a")).toBe(false);
    expect(s.archivedAt().get("a")).toBe(2);
    expect(s.archive("a", 3)).toBe(false);
    expect(s.unarchive("a", 4)).toBe(true);
    expect(s.archivedAt().has("a")).toBe(false);
    expect(s.unarchive("a", 5)).toBe(false);
  });

  test("clearDisposition reports what it cleared (drives the ↺ marker)", () => {
    const s = fresh();
    s.snooze("a", 1000, 1);
    expect(s.clearDisposition("a", 2, "reply")).toBe("snoozed");
    expect(s.clearDisposition("a", 3, "reply")).toBeNull();
  });
});

describe("device_id (wake push routing)", () => {
  test("snooze records the setter device; block and Mac snoozes leave it null", () => {
    const s = fresh();
    s.snooze("a", 1000, 1, "phone-dev-1");
    expect(s.dispositions().get("a")!.deviceId).toBe("phone-dev-1");
    s.block("a", "waiting", 2); // a later block must not keep the stale device
    expect(s.dispositions().get("a")!.deviceId).toBeNull();
    s.snooze("b", 1000, 1);
    expect(s.dispositions().get("b")!.deviceId).toBeNull();
  });

  test("guarded ALTER adds the column to a pre-device_id DB, idempotently", async () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/inbox-store-migrate-${process.pid}.db`;
    const { Database } = await import("bun:sqlite");
    const old = new Database(path, { create: true });
    old.exec(`CREATE TABLE dispositions(
      session_id   TEXT PRIMARY KEY,
      kind         TEXT NOT NULL CHECK(kind IN ('snoozed','blocked')),
      until        INTEGER,
      note         TEXT,
      created_at   INTEGER NOT NULL,
      auto_resumed INTEGER NOT NULL DEFAULT 0
    );`);
    old.exec("INSERT INTO dispositions(session_id, kind, until, created_at) VALUES ('pre', 'snoozed', 5, 1)");
    old.close();
    const a = new InboxStore(path); // migrates
    expect(a.dispositions().get("pre")!.deviceId).toBeNull();
    a.snooze("pre", 9, 2, "dev-x");
    a.close();
    const b = new InboxStore(path); // reopen — ALTER must not re-fire
    expect(b.dispositions().get("pre")!.deviceId).toBe("dev-x");
    b.close();
    await Bun.$`rm -f ${path} ${path}-wal ${path}-shm`.quiet();
  });
});

describe("event log", () => {
  test("every verb leaves an event, newest first", () => {
    const s = fresh();
    s.snooze("a", 1000, 1);
    s.clearDisposition("a", 2, "reply");
    s.archive("a", 3);
    s.unarchive("a", 4);
    expect(s.events("a").map((e) => e.type)).toEqual(["unarchive", "archive", "unpark", "snooze"]);
    expect(JSON.parse(s.events("a")[2]!.meta!)).toEqual({ reason: "reply", was: "snoozed" });
  });
});

describe("latestEvent", () => {
  test("returns the newest event with parsed meta, null when none", () => {
    const s = fresh();
    expect(s.latestEvent("a")).toBeNull();
    s.snooze("a", 1000, 1);
    s.clearDisposition("a", 2, "manual");
    expect(s.latestEvent("a")).toEqual({ type: "unpark", meta: { reason: "manual", was: "snoozed" } });
  });
});

describe("snapshot + kv", () => {
  test("snapshot is replace-wholesale and opaque", () => {
    const s = fresh();
    s.saveSnapshot([{ sessionId: "a", data: '{"x":1}' }], 1);
    s.saveSnapshot([{ sessionId: "b", data: '{"y":2}' }], 2);
    const rows = s.loadSnapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sessionId).toBe("b");
    expect(JSON.parse(rows[0]!.data)).toEqual({ y: 2 });
  });

  test("kv round-trips", () => {
    const s = fresh();
    expect(s.getKV("parked")).toBeNull();
    s.setKV("parked", "1");
    s.setKV("parked", "0");
    expect(s.getKV("parked")).toBe("0");
  });
});

describe("peeks", () => {
  test("set / read / clear; re-peeking replaces the record", () => {
    const s = fresh();
    expect(s.peeks().size).toBe(0);
    s.setPeek("a", "@1", 10);
    s.setPeek("b", "@2", 20);
    s.setPeek("a", "@3", 30); // re-peek → new window + timestamp
    expect(s.peeks().get("a")).toEqual({ windowId: "@3", openedAt: 30 });
    expect(s.peeks().get("b")).toEqual({ windowId: "@2", openedAt: 20 });
    s.clearPeek("a");
    expect(s.peeks().has("a")).toBe(false);
    expect(s.peeks().has("b")).toBe(true);
  });

  test("a peek leaves an event; clearing does not", () => {
    const s = fresh();
    s.setPeek("a", "@1", 10);
    s.clearPeek("a");
    expect(s.events("a").map((e) => e.type)).toEqual(["peek"]);
  });

  test("replyObserved drops peek + disposition + archive in one verb, reports the kind", () => {
    const s = fresh();
    s.snooze("a", 1000, 1);
    s.setPeek("a", "@1", 2);
    expect(s.replyObserved("a", 3)).toBe("snoozed");
    expect(s.peeks().has("a")).toBe(false);
    expect(s.dispositions().has("a")).toBe(false);
    s.archive("b", 1);
    s.setPeek("b", "@2", 2);
    expect(s.replyObserved("b", 3)).toBeNull(); // archived, no disposition
    expect(s.archivedAt().has("b")).toBe(false);
    expect(s.replyObserved("c", 4)).toBeNull(); // nothing to clear — no-op
  });

  test("schema is upgrade-safe: reopening an existing db keeps data and gains peeks", async () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/inbox-store-upgrade-${process.pid}.db`;
    const a = new InboxStore(path);
    a.snooze("a", 1000, 1);
    a.setPeek("a", "@1", 2);
    a.close();
    const b = new InboxStore(path); // schema exec runs again on open
    expect(b.dispositions().get("a")!.until).toBe(1000);
    expect(b.peeks().get("a")).toEqual({ windowId: "@1", openedAt: 2 });
    b.close();
    await Bun.$`rm -f ${path} ${path}-wal ${path}-shm`.quiet();
  });
});

describe("links", () => {
  test("first link wins; parentOf resolves", () => {
    const s = fresh();
    s.link("child", "parent", "handoff", 1);
    s.link("child", "other", "fork", 2); // ignored — capture-at-creation is authoritative
    expect(s.parentOf("child")).toEqual({ parentId: "parent", kind: "handoff" });
    expect(s.parentOf("nobody")).toBeNull();
  });
});

describe("cross-connection change detection", () => {
  test("data_version bumps for a reader when another connection commits", async () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/inbox-store-test-${process.pid}.db`;
    const a = new InboxStore(path);
    const b = new InboxStore(path);
    const before = a.dataVersion();
    b.snooze("x", 1000, 1);
    expect(a.dataVersion()).toBeGreaterThan(before);
    a.close();
    b.close();
    await Bun.$`rm -f ${path} ${path}-wal ${path}-shm`.quiet();
  });
});
