# Implementation 3 — Monorepo + Mobile App

> **Status:** DRAFT — for agent iteration.
> **Depends on:** Implementation 2 (stable, headless `core/` API).
> **Unblocks:** the actual goal — using sessions from the iPhone.
>
> **⛔ Gate:** Do not write code until **Gate C** in
> [`04-verification-gates.md`](./04-verification-gates.md) is 🟢. See the
> Enforcement protocol in [`00-overview.md`](./00-overview.md).

## Goal

Restructure CSM into a monorepo, extract the reusable Claude-wrapping logic into
a shared package, and add (a) a bridge server that runs on EC2 and (b) a mobile
PWA that talks to it over Tailscale, with push notifications via ntfy.

This implementation should be **mostly additive**. The hard problems (status,
transcript, approval) were solved in Implementation 2; here we expose them over
HTTP/WS and render them on a phone.

> **⚠️ MVP reframe (Resolved decisions, doc 00) — read first.** The title of this
> doc is now aspirational. For the MVP:
> - **No monorepo.** Build the bridge as `src/bridge/server.ts` importing
>   `src/core/*` directly (same shape as `monitor.ts`). The `packages/*` workspace
>   split below is an *optional later iteration*, not MVP. Guard the core boundary
>   with a lint rule / tiny test banning `blessed`/`ui` imports under `core/`.
> - **MVP product = a plain mobile-Safari web page**, manual-open over Tailscale,
>   delivering the five interactions. **PWA install (service worker / push) and
>   ntfy are optional next iterations**, not MVP.
> - **Transport = SSE** (decided). **App stack = Preact + `@preact/signals` +
>   `htm`, no build** (decided). **Push = hosted ntfy, contentless** (decided).
> - Optional-iteration order: (1) push (ntfy, contentless), (2) PWA install,
>   (3) monorepo split, (4) EC2.
>
> The "Monorepo layout" and "Migration steps" sections below apply only to
> optional iteration #3; everything else (bridge, app screens, ntfy, deployment)
> is reconciled inline.

## Why last

- The mobile app must consume the *stable* internal API from Impl #2. Building it
  on the current scraper would bake fragility into the product.
- It is the largest surface (new packages, a web app, deployment) but the
  lowest-risk *logic*, because it adds presentation/transport, not new
  Claude-wrapping behavior.

## Monorepo layout (proposed — Bun workspaces)

```
csm/                          # repo root
  package.json                # { "workspaces": ["packages/*", "apps/*"] }
  packages/
    core/                     # extracted from src/core/* — headless, no blessed
      package.json            # name: @csm/core
      src/
        sessions.ts transcript.ts event-status.ts hook-events.ts
        approval.ts tmux.ts process.ts state.ts notifications.ts ...
    cli/                      # the existing TUI + subcommands
      package.json            # name: @csm/cli, bin: csm  → depends on @csm/core
      src/                    # index.ts, cli.ts, monitor.ts, ui/*
    bridge/                   # NEW — HTTP/WS server for the phone
      package.json            # name: @csm/bridge  → depends on @csm/core
      src/server.ts
  apps/
    mobile/                   # NEW — the PWA
      package.json            # name: @csm/mobile
      ...
  docs/plans/iphone-sessions/ # these documents
```

### Migration steps (keep it non-breaking)

1. Introduce Bun workspaces at the root; create `packages/core` and move
   `src/core/*` into it as `@csm/core`. Update imports (`../core/x` →
   `@csm/core`).
2. Move the TUI (`src/index.ts`, `src/cli.ts`, `src/monitor.ts`, `src/ui/*`,
   `bin/csm.ts`) into `packages/cli` depending on `@csm/core`.
3. Verify `bun run start`, `bun run status`, all subcommands, and the test suite
   still pass unchanged. This step ships with **zero behavior change** — it is a
   pure restructure, reviewable as such.
4. Only then add `packages/bridge` and `apps/mobile`.

> Decide whether to do the monorepo split *before* or *after* the bridge exists.
> Recommended: split first (steps 1–3) as its own reviewable change, then build
> the bridge and app on the clean package boundary.

## Bridge server (`src/bridge/` for MVP; `packages/bridge` only after the split)

Thin Bun (`Bun.serve`) server. For MVP it lives at `src/bridge/server.ts` and
imports `src/core/*` directly (after the optional monorepo split it becomes
`@csm/bridge` importing `@csm/core`). Adds **no** Claude-wrapping logic. Runs on
the **Mac** alongside the sessions for MVP (the EC2 box later).

**Endpoints (initial):**

| Method | Path | Backed by `@csm/core` |
|--------|------|------------------------|
| `GET` | `/sessions` | `discoverSessions()` (event-sourced status) |
| `GET` | `/sessions/:id/transcript` | `getTranscript(id)` |
| `GET` | `/sessions/:id/thumbnail` | `capturePane(paneId)` (optional, fallback) |
| `GET` | `/pending` | `listPendingApprovals()` |
| `POST` | `/sessions/:id/decision` | `decideApproval(id, allow\|deny)` |
| `POST` | `/sessions/:id/message` | `sendMessage(id, text)` |
| `POST` | `/sessions/:id/answer` | answer an `AskUserQuestion` by option index |
| `GET` | `/stream` (SSE or WS) | watch events dir → push updates |
| `POST` | `/sessions/:id/kill`, `/rename` | reuse `tmux.ts` (optional) |

**Cross-cutting (decided — Resolved decisions, doc 00):**
- **Transport: SSE** (not WS), driven by a **debounced watch of the events dir**
  (no polling). The live channel is strictly server→client; all actions are plain
  `POST`. SSE's built-in auto-reconnect matters for a phone that sleeps/wakes/roams
  on Tailscale. Add a WS endpoint only if a genuinely bidirectional feature (e.g. a
  terminal fallback) appears.
- **Auth:** bind-to-tailnet is the real wall; static bearer token (env var) is
  defense-in-depth, **constant-time** compared, never logged. The bridge
  **fails closed** — refuses to start if asked to bind to a non-loopback /
  non-tailnet address, so a future copy-paste can't expose RCE publicly.
- **Security:** the `decision` / `message` / `answer` endpoints are
  remote-code-execution by design. Bind to the Tailscale interface only; never
  expose publicly.
- **iOS secure-context:** plain HTTP over the tailnet is fine for a non-installed
  web page (MVP). The service worker / PWA install (optional iteration #2) may
  require a secure context → plan for **`tailscale serve` HTTPS**, confirmed during
  that iteration (Gate C5).

## Push notifications (optional iteration #1 — the "I'm at the gym" feature)

> **Not MVP.** The MVP web page is manual-open; push is the first optional
> iteration because it delivers the actual remote-control value. It doesn't need
> PWA install — the ntfy iOS app delivers the alert and the deep link opens Safari.

- Drive from the `Notification` hook and `core/notifications.ts` transition
  detection (running→waiting = "blocked", running→ready = "turn complete").
- Use **hosted ntfy.sh**: HTTP POST to a topic; the ntfy iOS app subscribes. No
  APNs, no Apple Developer account, no App Store.
- **Contentless payload (decided — Resolved decisions, doc 00):** carry only a
  non-sensitive label + a deep link (`sessionId` → app route) — e.g.
  *"`csm/fix-auth` needs permission"* / *"`api` has a question"* / *"… turn
  complete"*. **Never** include the tool input, diff, command, or question text;
  the app fetches those from the bridge **over Tailscale** when you tap. The push
  traverses ntfy.sh + Apple APNs (third parties), so no private dev content may
  cross it. Self-host ntfy only if a session *label* itself ever feels too
  revealing.

## Mobile app (`src/bridge/` static assets for MVP; `apps/mobile` only after the split)

**MVP = a plain mobile-Safari web page**, manual-open over Tailscale (no service
worker). Installability (add-to-home-screen + service worker) is **optional
iteration #2**, not MVP — that's where the iOS secure-context / `tailscale serve`
HTTPS question gets resolved in isolation. Rationale for web-first: the
*interactions* (the UX being tested) are identical installed or not, so opening in
Safari fully validates "remote control with great UX" without the ntfy/APNs/SW
surface. Native iOS is out of scope unless a hard requirement (e.g. a true
interactive terminal fallback) forces it — and even then the right move is
`ttyd`/`wetty` streaming a specific pane *alongside* the button UI, not instead.

**Stack (decided — Resolved decisions, doc 00): Preact + `@preact/signals` +
`htm`, no build step**, served as ES modules. Signals map 1:1 onto SSE pushes (an
SSE message updates a signal → the list/detail re-render), which is the whole
interaction model; `htm` avoids a JSX compiler so there's no toolchain. ~5KB,
consistent with CSM's low-dependency ethos. Inline assets; mobile-first CSS. The
service worker is added only in optional iteration #2.

**Screens:**
1. **Session list** — status dots (event-sourced), repo grouping (reuse grouping
   logic from `@csm/core`), ⚡ attention first. Live via `/stream`.
2. **Session detail** — structured transcript (last N turns), live updates.
3. **Approval card** — for a pending tool: show `tool` + `input` (the diff /
   command), Allow / Deny buttons → `POST /decision`.
4. **Question card** — `AskUserQuestion` options as buttons → `POST /answer`.
5. **Message box** — free text → `POST /message` (enabled only when at prompt).

**Offline/connectivity:** assume Tailscale is up; degrade gracefully when the
bridge is unreachable (show last-known state, queue nothing dangerous).

## Deployment / ops

**MVP (Mac):**
- The Mac, kept awake (`caffeinate` / never-sleep), running tmux + zsh + `claude`
  + CSM + the `src/bridge` server (e.g. a tmux window or a `launchd` agent).
- Tailscale on Mac and iPhone; bridge bound to the tailnet address (fail-closed).
- `csm setup` (extended in Impl #2) installs the hooks.

**Optional iteration #4 (EC2):**
- Always-on Linux EC2 instance running the same stack. Keep Darwin-only calls out
  of `core/`/`bridge/` so this is a config change, not a port (doc 00).
- Document the bring-up runbook: instance, Tailscale join, headless `claude` auth,
  hook install, bridge service, ntfy topic.

## Acceptance criteria

- Monorepo split lands as a behavior-neutral change: all existing CSM commands
  and tests pass unchanged.
- From the iPhone PWA over Tailscale: see live session list + statuses, read a
  session's conversation, approve a tool prompt, answer a question, send a
  message — all against a real session running on EC2.
- A session blocking on permission pushes an ntfy notification that deep-links to
  the approval card.

## Open questions

**Resolved (see Resolved decisions, doc 00) — kept for traceability:**
- ~~PWA framework choice~~ → **Preact + `@preact/signals` + `htm`, no build.**
- ~~SSE vs WebSocket~~ → **SSE**, debounced events-dir watch.
- ~~ntfy hosted vs self-hosted~~ → **hosted, contentless payload**; self-host only
  if a session label is too revealing.
- ~~Monorepo tooling~~ → **no monorepo for MVP**; bridge as `src/bridge/`. If/when
  the split happens (optional iteration #3), default to plain Bun workspaces.
- ~~Session launch from the phone~~ → **out of scope** until after all optional
  iterations; MVP is "continue existing sessions."

**Still open:**
- [ ] Do we want a read-only "big terminal" fallback (ttyd) for the rare case the
      button UI can't express something? Defer unless needed.
- [ ] Exact iOS secure-context behavior over the tailnet (plain HTTP vs
      `tailscale serve` HTTPS) — resolve during optional iteration #2 (PWA install).
