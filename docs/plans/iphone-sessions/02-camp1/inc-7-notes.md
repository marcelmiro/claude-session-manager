# Inc7 notes — monitor/notifications reconcile + rotation + boundary guard

Detail for the dense Inc7 block in [`plan.md`](./plan.md). Five concerns, kept out
of the main block for review scannability.

## 1. Event-source the attention path
`notifications.ts` `detectTransitions()` currently diffs a `Map<paneId,
SessionStatus>` built from viewport scraping. Replace its input with the
event-sourced statuses produced by Inc4 (`deriveStatus` per session) so
`classifyTransition()` (running→waiting = "blocked", running→ready =
"turnComplete") fires on real hook edges. The prefix logic (`desiredPrefix()`,
`syncWindowPrefix()`) is unchanged — only its status source changes.

## 2. Monitor reads event logs
`monitor.ts` is "the sole authority for window naming" (CLAUDE.md). Its fast phase
must call `readEvents()` + `deriveStatus()` for active panes instead of
`detectStatus(capturePane())`. This is what makes `tmux status-right` (`⚡3 🔄2`)
and window prefixes correct on scroll-up — without it the headline bug persists in
the monitor path even though the TUI list is fixed.

## 3. IPC + event-log rotation/cleanup
On each refresh, for any `events/`, `pending/`, or `decisions/` file whose
`<session_id>` has **no live tmux pane**, remove it (reaps zombie approvals left by
a killed pane mid-block, and unbounded dead-session logs). Liveness is already
computed during discovery (pane↔session correlation) — reuse it; do not add a new
scan. This is the cleanup the data-model §7 GC refers to.

## 4. Deterministic fallback width
Sessions that still use the scraper fallback (pre-hook) must capture at a pinned
width so `status.ts` patterns stay deterministic: `tmux new-session -x 120` (or set
width on launch). Document the pin; do not reflow existing panes.

## 5. `core/` import-boundary guard (`src/core/boundary.test.ts`)
A `bun:test` that asserts no file under `src/core/` imports `blessed` or anything
under `src/ui/` — keeping `core/` headless and EC2/Linux-portable (ADR-6). Shape:

```ts
import { test, expect } from "bun:test";
import { Glob } from "bun";
test("core/ has no blessed or ui imports", async () => {
  const offenders: string[] = [];
  for await (const f of new Glob("src/core/**/*.ts").scan(".")) {
    if (f.endsWith(".test.ts")) continue;
    const src = await Bun.file(f).text();
    if (/from ["']blessed["']|from ["'][^"']*\/ui\//.test(src)) offenders.push(f);
  }
  expect(offenders).toEqual([]);
});
```
This is the artifact V8 and Inc7's done criterion reference; it does not exist yet.
