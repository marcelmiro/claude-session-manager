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
  process.env.CSM_BRIDGE_TOKEN = TOKEN;
  process.env.CSM_BRIDGE_PORT = "0"; // ephemeral — never collides with a live bridge
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
