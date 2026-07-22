// Service worker: Web Push receiver + notification click routing. No caching —
// the app is served no-cache on purpose; this worker exists only for push.
// skipWaiting/claim so an updated worker takes over on next launch instead of
// iOS's lazy default (otherwise stale push handlers linger for days).

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
      await self.registration.showNotification(p.title || "portkey", {
        body: p.body || "",
        // One notification per session — a later push replaces the earlier one, so
        // the shade always shows each session's LATEST state (still buzzes via renotify).
        tag: sessionId || "csm",
        renotify: true,
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

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = (event.notification.data || {}).sessionId || "";
  event.waitUntil(
    (async () => {
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
