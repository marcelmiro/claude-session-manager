# Implementation 3 — Monorepo + Mobile App

> **Status:** DRAFT — for agent iteration.
> **Depends on:** Implementation 2 (stable, headless `core/` API).
> **Unblocks:** the actual goal — using sessions from the iPhone.

## Goal

Restructure CSM into a monorepo, extract the reusable Claude-wrapping logic into
a shared package, and add (a) a bridge server that runs on EC2 and (b) a mobile
PWA that talks to it over Tailscale, with push notifications via ntfy.

This implementation should be **mostly additive**. The hard problems (status,
transcript, approval) were solved in Implementation 2; here we expose them over
HTTP/WS and render them on a phone.

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

## Bridge server (`packages/bridge`)

Thin Bun (`Bun.serve`) server. Imports `@csm/core`; adds **no** Claude-wrapping
logic. Runs on the EC2 box alongside the sessions.

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

**Cross-cutting:**
- **Auth:** static bearer token (env var), checked on every request. Single user.
- **Transport:** SSE is simplest for one-way updates; use WS if bidirectional
  later. Push on event-log change rather than polling.
- **Security:** the `decision` / `message` / `answer` endpoints are
  remote-code-execution by design. Bind to the Tailscale interface only; never
  expose publicly. Token is defense-in-depth, not the only layer.

## Push notifications (the "I'm at the gym" feature)

- Drive from the `Notification` hook and `core/notifications.ts` transition
  detection (running→waiting = "blocked", running→ready = "turn complete").
- Use **ntfy.sh**: HTTP POST to a topic; the ntfy iOS app subscribes. No APNs, no
  Apple Developer account, no App Store. Self-host ntfy later if desired.
- Payload: session label + what it needs (permission for `<tool>` / question /
  done) + a deep link into the PWA for that session.

## Mobile app (`apps/mobile`)

A **PWA**, installed to the home screen. Rationale: no App Store review, no
native toolchain, instant iteration, and the interaction set (lists, buttons,
text box) needs no native capability. Native iOS is explicitly out of scope
unless a hard requirement (e.g. a true interactive terminal fallback) forces it —
and even then, the right move is `ttyd`/`wetty` streaming a specific pane
*alongside* the button UI, not instead of it.

**Stack:** keep it minimal. Vanilla + a tiny lib (e.g. Lit/Preact) over a heavy
framework, consistent with CSM's low-dependency ethos. Inline assets; mobile-first
CSS; one service worker for installability.

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

## Deployment / ops (EC2)

- Always-on EC2 instance running tmux + zsh + `claude` + `@csm/cli` +
  `@csm/bridge` (e.g. under a process manager or a tmux window / systemd service).
- Tailscale on EC2 and iPhone; bridge bound to the tailnet address.
- `csm setup` (extended in Impl #2) installs the hooks on this box.
- Document the bring-up runbook: instance, Tailscale join, `claude` auth, hook
  install, bridge service, ntfy topic.

## Acceptance criteria

- Monorepo split lands as a behavior-neutral change: all existing CSM commands
  and tests pass unchanged.
- From the iPhone PWA over Tailscale: see live session list + statuses, read a
  session's conversation, approve a tool prompt, answer a question, send a
  message — all against a real session running on EC2.
- A session blocking on permission pushes an ntfy notification that deep-links to
  the approval card.

## Open questions

- [ ] PWA framework choice (Lit vs Preact vs vanilla) — pick the smallest that
      makes the live-updating list pleasant.
- [ ] SSE vs WebSocket for `/stream`.
- [ ] ntfy.sh hosted vs self-hosted (privacy of prompt text in notifications).
- [ ] Do we want a read-only "big terminal" fallback (ttyd) for the rare case the
      button UI can't express something? Defer unless needed.
- [ ] Session *launch* from the phone (new wizard equivalent) — in scope for v1
      or later? Probably later; v1 is "continue existing sessions."
- [ ] Monorepo tooling: plain Bun workspaces vs adding Turborepo/nx. Default to
      plain Bun workspaces (low dep ethos).
