#!/usr/bin/env bun
/**
 * shoot.ts — screenshot the bridge mobile UI headlessly (zero deps).
 *
 * Boots the bridge in fixtures mode, drives headless Chrome over the DevTools Protocol
 * (sets the auth cookie — CDP bypasses HttpOnly — navigates, captures PNGs of the
 * login / list / detail screens), then tears everything down. Lets an agent or human
 * VISUALLY verify CSS/layout changes without an iPhone.
 *
 *   bun run scripts/shoot.ts [--out <dir>] [--port <n>] [--cdp-port <n>] [--keep]
 *
 * Requires Google Chrome (or set CHROME=/path/to/chrome). Writes login.png, list.png,
 * detail.png to <dir> (default: $TMPDIR/csm-shots).
 */

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, ".."); // repo root, for spawning `bin/csm.ts`
const args = process.argv.slice(2);
const flag = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const OUT = flag("--out", join(tmpdir(), "csm-shots"));
const BRIDGE_PORT = Number(flag("--port", "8479"));
const CDP_PORT = Number(flag("--cdp-port", "9223"));
const KEEP = args.includes("--keep");
const TOKEN = process.env.CSM_BRIDGE_TOKEN || "shoot-token";
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;

const log = (m: string) => console.error(`[shoot] ${m}`);

function resolveChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error("Chrome not found — install it or set CHROME=/path/to/chrome");
}

async function waitFor(fn: () => Promise<boolean>, label: string, tries = 80, gap = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await fn()) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(gap);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// --- Minimal CDP client over the page target's WebSocket (request/response + events) ---
class CDP {
  private id = 0;
  private pending = new Map<number, (v: any) => void>();
  private events = new Map<string, Array<(p: any) => void>>();
  constructor(private ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String((e as MessageEvent).data));
      if (msg.id != null && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg.result);
        this.pending.delete(msg.id);
      } else if (msg.method) {
        for (const cb of this.events.get(msg.method) ?? []) cb(msg.params);
      }
    });
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res) => this.pending.set(id, res));
  }
  once(method: string): Promise<any> {
    return new Promise((res) => {
      const cb = (p: any) => {
        this.events.set(method, (this.events.get(method) ?? []).filter((c) => c !== cb));
        res(p);
      };
      this.events.set(method, [...(this.events.get(method) ?? []), cb]);
    });
  }
}

async function openCDP(): Promise<CDP> {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const page = targets.find((t: any) => t.type === "page") ?? targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("CDP websocket failed")));
  });
  return new CDP(ws);
}

async function navigate(cdp: CDP, url: string) {
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url });
  await loaded;
}

async function shoot(cdp: CDP, file: string, settleMs = 700) {
  await Bun.sleep(settleMs); // let the SPA fetch + render + finish entry animations
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await Bun.write(join(OUT, file), Buffer.from(data, "base64")); // Bun.write makes parent dirs
  log(`wrote ${join(OUT, file)}`);
}

let bridge: ReturnType<typeof Bun.spawn> | null = null;
let chrome: ReturnType<typeof Bun.spawn> | null = null;

async function main() {
  const CHROME = resolveChrome();

  // 1. Boot the bridge in fixtures mode.
  bridge = Bun.spawn(["bun", "run", "bin/csm.ts", "bridge"], {
    cwd: ROOT,
    env: {
      ...process.env,
      CSM_BRIDGE_TOKEN: TOKEN,
      CSM_BRIDGE_HOST: "127.0.0.1",
      CSM_BRIDGE_PORT: String(BRIDGE_PORT),
      CSM_BRIDGE_FIXTURES: "1",
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  await waitFor(async () => (await fetch(BASE)).ok, "bridge");
  log(`bridge up on ${BASE} (fixtures)`);

  // 2. Launch headless Chrome with a throwaway profile + remote debugging.
  const profile = mkdtempSync(join(tmpdir(), "csm-chrome-"));
  chrome = Bun.spawn(
    [
      CHROME,
      "--headless=new",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  await waitFor(async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok, "chrome devtools");

  const cdp = await openCDP();
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  // iPhone-ish viewport (the app caps content at 680px; 402 keeps the mobile layout).
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 402, height: 874, deviceScaleFactor: 2, mobile: true });

  // 3a. Login screen — no cookie yet → /sessions 401 → login renders.
  await navigate(cdp, `${BASE}/`);
  await shoot(cdp, "login.png");

  // 3b. Set the auth cookie (CDP bypasses HttpOnly), reload → session list.
  await cdp.send("Network.setCookie", { name: "csm", value: TOKEN, domain: "127.0.0.1", path: "/" });
  await navigate(cdp, `${BASE}/`);
  await shoot(cdp, "list.png");

  // 3c. Open the first (blocked) session → detail with the question card + styled tags.
  await cdp.send("Runtime.evaluate", { expression: "document.querySelector('.row')?.click()" });
  await shoot(cdp, "detail.png", 900);

  log(`done → ${OUT}`);
}

main()
  .catch((e) => {
    log(`error: ${e?.message ?? e}`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (KEEP) {
      log("--keep set: leaving bridge + chrome running");
      return;
    }
    try {
      chrome?.kill();
    } catch {}
    try {
      bridge?.kill();
    } catch {}
  });
