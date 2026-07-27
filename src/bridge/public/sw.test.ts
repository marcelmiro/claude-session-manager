/**
 * The service worker's remaining job: show the notification, and — on a COLD launch only —
 * stash the tapped session for the booting page.
 *
 * iOS dispatches `notificationclick` ONLY when the PWA is force-quit, so nothing here runs
 * on a warm tap. That case is attributed server-side instead (see the recent-push ledger in
 * core/web-push.ts + shared/tap-target.js), because a warm-resumed page also reads a stale
 * CacheStorage snapshot and cannot see what the worker wrote. Runs sw.js in a fake
 * ServiceWorkerGlobalScope so the real handler is under test, not a paraphrase of it.
 */
import { test, expect } from "bun:test";

const SW_PATH = `${import.meta.dir}/sw.js`;

function makeScope() {
  const listeners = new Map<string, ((ev: unknown) => void)[]>();
  const store = new Map<string, string>();
  const shown: { title: string; tag: string; data: unknown }[] = [];
  const posted: unknown[] = [];
  const opened: string[] = [];

  const caches = {
    async open() {
      return {
        async put(k: string, res: Response) {
          store.set(k, await res.text());
        },
        async match(k: string) {
          const v = store.get(k);
          return v === undefined ? undefined : new Response(v);
        },
        async delete(k: string) {
          store.delete(k);
        },
      };
    },
  };

  const scope = {
    addEventListener(t: string, fn: (ev: unknown) => void) {
      listeners.set(t, [...(listeners.get(t) ?? []), fn]);
    },
    skipWaiting() {},
    registration: {
      async showNotification(title: string, o: { tag: string; data: unknown }) {
        // Real tag semantics: one notification per tag, latest wins.
        const i = shown.findIndex((n) => n.tag === o.tag);
        const rec = { title, tag: o.tag, data: o.data };
        if (i >= 0) shown[i] = rec;
        else shown.push(rec);
      },
      async getNotifications() {
        return shown;
      },
    },
    clients: {
      async claim() {},
      async matchAll() {
        return windows;
      },
      async openWindow(url: string) {
        opened.push(url);
      },
    },
    caches,
    navigator: { async setAppBadge() {} },
  };

  let windows: { focus(): Promise<void>; postMessage(m: unknown): void }[] = [];
  const setWindows = (n: number) => {
    windows = Array.from({ length: n }, () => ({
      async focus() {},
      postMessage: (m: unknown) => posted.push(m),
    }));
  };

  async function dispatch(type: string, ev: Record<string, unknown>) {
    const waits: Promise<unknown>[] = [];
    ev.waitUntil = (p: Promise<unknown>) => waits.push(p);
    for (const fn of listeners.get(type) ?? []) fn(ev);
    await Promise.all(waits);
  }

  return { scope, store, shown, posted, opened, dispatch, setWindows };
}

async function loadWorker() {
  const h = makeScope();
  const src = await Bun.file(SW_PATH).text();
  // sw.js is a classic worker — no imports — so evaluating it with `self` bound is faithful.
  // An ESM `import` here would be a parse error on device and silently leave the OLD worker
  // active, so this doubles as a guard against that regression.
  new Function("self", "caches", "navigator", "Response", "fetch", src)(
    h.scope,
    h.scope.caches,
    h.scope.navigator,
    Response,
    async () => new Response("{}"),
  );
  return h;
}

const push = (sessionId: string, title = "✅ repo · Name") => ({
  data: { json: () => ({ title, body: "", sessionId }) },
});

const click = (sessionId: string) => ({
  notification: { data: { sessionId }, tag: sessionId, close() {} },
});

test("a push shows a notification tagged with its session", async () => {
  const h = await loadWorker();
  await h.dispatch("push", push("s1"));

  expect(h.shown).toHaveLength(1);
  expect(h.shown[0]!.tag).toBe("s1");
  expect(h.shown[0]!.data).toEqual({ sessionId: "s1" });
});

test("re-push for the same session replaces, never stacks", async () => {
  const h = await loadWorker();
  await h.dispatch("push", push("s1", "⚡ first"));
  await h.dispatch("push", push("s1", "✅ second"));

  expect(h.shown).toHaveLength(1);
  expect(h.shown[0]!.title).toBe("✅ second");
});

test("a malformed payload still shows something — iOS drops silent subscriptions", async () => {
  const h = await loadWorker();
  await h.dispatch("push", {
    data: {
      json() {
        throw new Error("not json");
      },
    },
  });

  expect(h.shown).toHaveLength(1);
  expect(h.shown[0]!.title).toBe("portkey");
});

test("cold launch stashes the tapped session for the booting page", async () => {
  const h = await loadWorker();
  h.setWindows(0);
  await h.dispatch("notificationclick", click("s1"));

  expect(JSON.parse(h.store.get("pending")!).sessionId).toBe("s1");
  expect(h.opened).toEqual(["/?s=s1"]);
});

// The launching window shows up in matchAll ~800ms before its JS boots, so the worker takes
// this branch on a cold launch too and the postMessage lands in a page with no listener.
// The stash must still happen or the deep link is lost entirely.
test("stashes even when a window already exists and the message may be dropped", async () => {
  const h = await loadWorker();
  h.setWindows(1);
  await h.dispatch("notificationclick", click("s2"));

  expect(JSON.parse(h.store.get("pending")!).sessionId).toBe("s2");
  expect(h.posted).toEqual([{ type: "open-session", sessionId: "s2" }]);
  expect(h.opened).toEqual([]);
});
