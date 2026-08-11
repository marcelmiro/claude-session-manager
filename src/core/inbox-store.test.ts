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
