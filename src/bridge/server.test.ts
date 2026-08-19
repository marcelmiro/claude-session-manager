/**
 * Bridge routes — the Web Push surface (`/push/*`) and the `/sw.js` no-cache
 * guarantee, exercised over a real `startBridge` server on an ephemeral port.
 * Auth is the real cookie exchange; core state lands under the temp HOME.
 *
 * `home` helper first — freezes PATHS/EVENTS_DIR under a temp HOME before
 * server.ts (via core/config) freezes them at import time.
 */

import "../../test/helpers/home";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { EVENTS_DIR } from "../core/hook-events";
import { CONSUMERS_DIR, fromB64url } from "../core/web-push";
import { startBridge } from "./server";

const TOKEN = "route-test-token";
let server: ReturnType<typeof startBridge>;
let base = "";
let cookie = "";

beforeAll(async () => {
  mkdirSync(EVENTS_DIR, { recursive: true });
  process.env.CLAUDE0_BRIDGE_TOKEN = TOKEN;
  process.env.CLAUDE0_BRIDGE_PORT = "0"; // ephemeral — never collides with a live bridge
  server = startBridge();
  base = `http://127.0.0.1:${server.port}`;
  const res = await fetch(`${base}/auth`, {
    method: "POST",
    body: JSON.stringify({ token: TOKEN }),
  });
  expect(res.status).toBe(200);
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
});

afterAll(() => {
  server?.stop(true);
});

const get = (path: string) => fetch(`${base}${path}`, { headers: { cookie } });
const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { cookie }, body: JSON.stringify(body) });

test("/push/vapid-key requires auth and returns a 65-byte P-256 key", async () => {
  expect((await fetch(`${base}/push/vapid-key`)).status).toBe(401);
  const res = await get("/push/vapid-key");
  expect(res.status).toBe(200);
  const { key } = (await res.json()) as { key: string };
  expect(fromB64url(key).length).toBe(65);
});

test("/push/subscribe validates deviceId, https endpoint, and keys", async () => {
  const sub = {
    endpoint: "https://web.push.apple.com/route-test",
    keys: { p256dh: "BPKEY", auth: "AUTH" },
  };
  expect((await post("/push/subscribe", { deviceId: "../traversal", subscription: sub })).status).toBe(400);
  expect(
    (
      await post("/push/subscribe", {
        deviceId: "route-test-device",
        subscription: { ...sub, endpoint: "http://insecure" },
      })
    ).status,
  ).toBe(400);
  expect((await post("/push/subscribe", { deviceId: "route-test-device" })).status).toBe(400);
  const ok = await post("/push/subscribe", { deviceId: "route-test-device", subscription: sub });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ ok: true });
});

test("/push/subscribed reflects server truth per device", async () => {
  const yes = (await (await get("/push/subscribed?device=route-test-device")).json()) as {
    subscribed: boolean;
  };
  expect(yes.subscribed).toBe(true);
  const no = (await (await get("/push/subscribed?device=never-subscribed-dev")).json()) as {
    subscribed: boolean;
  };
  expect(no.subscribed).toBe(false);
});

test("/push/goodbye unlinks the device's consumer marker (text/plain body)", async () => {
  mkdirSync(CONSUMERS_DIR, { recursive: true });
  const marker = `${CONSUMERS_DIR}/goodbye-dev-1`;
  writeFileSync(marker, "");
  const res = await fetch(`${base}/push/goodbye`, {
    method: "POST",
    headers: { cookie },
    body: "goodbye-dev-1",
  });
  expect(res.status).toBe(200);
  expect(existsSync(marker)).toBe(false);
});

test("/sw.js is served no-cache (a stale service worker would render old payloads)", async () => {
  const res = await fetch(`${base}/sw.js`); // static — public by design
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-cache");
  expect(res.headers.get("content-type")).toContain("javascript");
});

// --- versioned state push (stream.ts protocol over a live server) -------------

// Read SSE frames from /stream until `pred` matches one parsed `data:` event (or
// the deadline passes). Returns the matched event, or null.
async function readStreamUntil(
  path: string,
  pred: (ev: Record<string, unknown>) => boolean,
  ms = 5000,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${base}${path}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (const line of buf.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (pred(ev)) return ev;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return null;
}

test("/stream pushes a seq-stamped sessions snapshot on connect", async () => {
  const ev = await readStreamUntil("/stream?device=stream-test-dev", (e) => e.type === "sessions");
  expect(ev).not.toBeNull();
  expect(typeof ev!.seq).toBe("number");
  expect(typeof ev!.computedAt).toBe("number");
  const payload = ev!.payload as { sessions: unknown[] };
  expect(Array.isArray(payload.sessions)).toBe(true);
});

test("/stream/open subscribes the device and pushes a transcript snapshot", async () => {
  const sub = await fetch(`${base}/stream/open`, {
    method: "POST",
    headers: { cookie, "x-claude0-device": "stream-test-dev" },
    body: JSON.stringify({ sessionId: "no-such-session" }),
  });
  expect(await sub.json()).toEqual({ ok: true });
  // A reconnect after subscribing must deliver the transcript snapshot on connect.
  const ev = await readStreamUntil(
    "/stream?device=stream-test-dev",
    (e) => e.type === "transcript" && e.sessionId === "no-such-session",
  );
  expect(ev).not.toBeNull();
  expect(ev!.kind).toBe("snapshot");
  const payload = ev!.payload as { turns: unknown[] };
  expect(Array.isArray(payload.turns)).toBe(true);
});

test("/stream/open validates its body and requires a device", async () => {
  const noDevice = await post("/stream/open", { sessionId: "x" });
  expect(noDevice.status).toBe(400);
  const badBody = await fetch(`${base}/stream/open`, {
    method: "POST",
    headers: { cookie, "x-claude0-device": "stream-test-dev" },
    body: JSON.stringify({ sessionId: 42 }),
  });
  expect(badBody.status).toBe(400);
});

test("/stream/open rejects a sessionId with glob/path metacharacters", async () => {
  for (const bad of ["*", "../../etc/passwd", "a/b", "a?b", "a[b]", "**", "x".repeat(101)]) {
    const res = await fetch(`${base}/stream/open`, {
      method: "POST",
      headers: { cookie, "x-claude0-device": "stream-test-dev" },
      body: JSON.stringify({ sessionId: bad }),
    });
    expect(res.status).toBe(400);
  }
});
