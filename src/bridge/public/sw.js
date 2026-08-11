// Service worker: Web Push receiver + notification click routing. No caching —
// the app is served no-cache on purpose; this worker exists only for push.
// skipWaiting/claim so an updated worker takes over on next launch instead of
// iOS's lazy default (otherwise stale push handlers linger for days).

const NAV_CACHE = "csm-nav";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  // iOS drops the subscription if a push shows nothing — always show, even on a
  // malformed payload.
  let p = {};
  try {
    p = event.data ? event.data.json() : {};
  } catch {
    /* fall through to the generic notification */
  }
  const sessionId = p.sessionId || "";
  event.waitUntil(
    (async () => {
      const tag = sessionId || "csm";
      // One notification per session — but never via same-tag REPLACEMENT: WebKit
      // ignores `renotify` (Chromium-only), so a replaced notification updates the
      // shade silently — no banner, no sound — and only the session's first push
      // ever alerts. Close the old one, then show fresh: a fresh show always
      // presents.
      try {
        for (const n of await self.registration.getNotifications({ tag })) n.close();
      } catch {
        /* worst case: iOS replaces silently, as before */
      }
      await self.registration.showNotification(p.title || "portkey", {
        body: p.body || "",
        tag,
        data: { sessionId },
      });
      // Badge = sessions currently notified (tag-deduped). Cleared by the app on focus.
      try {
        const shown = await self.registration.getNotifications();
        await navigator.setAppBadge(shown.length);
      } catch {
        /* badge unsupported — fine */
      }
    })(),
  );
});

// Hand the tapped session off through the Cache API — shared between this worker
// and the page. iOS cold-launches an installed PWA at its start_url and routinely
// drops the `?s=` on openWindow(), so the URL alone loses the deep link on the most
// common (evicted) path; the app reads this on boot and on foreground instead.
async function stashTarget(sessionId) {
  if (!sessionId) return;
  try {
    const cache = await caches.open(NAV_CACHE);
    await cache.put("pending", new Response(JSON.stringify({ sessionId, at: Date.now() })));
  } catch {
    /* cache unavailable — the ?s= URL and postMessage paths still try */
  }
}

// Only reached on a COLD launch — iOS never dispatches this to an already-running PWA.
// Stash first: on that cold path `matchAll()` already returns the launching window ~800ms
// before its JS boots, so the postMessage below lands in a page with no listener yet and
// `openWindow` is never reached. The stash is what actually carries the deep link; the
// other two are belt-and-braces for platforms that behave.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = (event.notification.data || {}).sessionId || "";
  event.waitUntil(
    (async () => {
      await stashTarget(sessionId);
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (wins.length > 0) {
        // focus() alone doesn't navigate — the app listens for this message and
        // re-runs its deep-link logic, switching to the notified session.
        try {
          await wins[0].focus();
        } catch {
          /* focus can fail without user activation — the message still lands */
        }
        wins[0].postMessage({ type: "open-session", sessionId });
        return;
      }
      await self.clients.openWindow(sessionId ? `/?s=${encodeURIComponent(sessionId)}` : "/");
    })(),
  );
});
